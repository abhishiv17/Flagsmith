import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, CATEGORY_LABEL, cityName, inr, PRICE_BANDS, SORTS, type CityCode, type SearchItem, type SearchResult, type SortKey } from '../api';
import { useCity } from '../state';
import { useDebounced, useLiveStock } from '../hooks';
import { revealCards, useGsap } from '../motion';
import { CardSkeleton, ProductCard } from '../components/ui';
import { SearchBox } from '../components/SearchBox';
import { ProductImage } from '../components/ProductImage';
import { track } from '../track';

const CONN_LABEL: Record<string, string> = {
  bluetooth: 'Bluetooth', wired: 'Wired', 'usb-c': 'USB-C', lightning: 'Lightning', 'micro-usb': 'Micro-USB',
  wifi: 'Wi-Fi', 'wireless-charging': 'Wireless charging', hdmi: 'HDMI',
};

/** Results per page; "Show more" fetches the next page. */
const PAGE_SIZE = 24;

/** Example searches that show off need-based search (doc/19). */
const TRY = [
  'keep my tea hot on the commute under 800',
  'gift for dad under 2000',
  'waterproof speaker for the shower',
  'noise cancelling headphones for flights',
  'something for my parents',
  'fan for power cuts',
  'black earbuds with 30 hour battery',
  'waterproof speaker under 1000',
];

/** Catalogue + search (doc/06 §2): OpenSearch-backed; the URL holds the query so results are shareable. */
export function Shop() {
  const { city, setCity } = useCity();
  const setCityTo = (c: string) => setCity(c as CityCode);
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const band = params.get('price') ?? '';
  const inStock = params.get('inStock') === 'true';
  const use = params.get('use') ?? '';
  // doc/19 facets
  const colour = params.get('colour') ?? '';
  const conn = params.get('conn') ?? '';
  const water = params.get('water') ?? '';
  const battery = params.get('battery') ?? '';
  const ignore = params.get('ignore') ?? '';
  const sort = (SORTS.some((x) => x.key === params.get('sort')) ? params.get('sort') : 'relevance') as SortKey;

  const [text, setText] = useState(q);
  const debounced = useDebounced(text, 250);
  const input = useRef<HTMLInputElement>(null);

  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  // "Show more": later pages, appended under the first.
  const [more, setMore] = useState<SearchItem[]>([]);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  // Debounced box → URL
  useEffect(() => {
    if (debounced.trim() !== q) update({ q: debounced.trim() || null, ignore: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  // Keep the box in sync if the URL changes from elsewhere (back button, clearing filters).
  useEffect(() => {
    if (q !== text.trim()) setText(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  // "/" focuses search (doc/06 §6)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!city) return;
    const ctrl = new AbortController();
    const qs = queryString(1);
    if (!qs) return;

    setLoading(true);
    setMore([]);
    setPage(1);
    api<SearchResult>(`/search?${qs}`, {}, ctrl.signal)
      .then((r) => {
        setResult(r);
        setError(null);
        if (q) track('search', { q, results: r.total });
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') setError(e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', String(e)));
      })
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city, q, category, band, inStock, use, ignore, colour, conn, water, battery, sort]);

  /** The search as a query string, for one page of results. */
  function queryString(pageNo: number): URLSearchParams | null {
    if (!city) return null;
    const qs = new URLSearchParams({ city, size: String(PAGE_SIZE), page: String(pageNo) });
    if (sort !== 'relevance') qs.set('sort', sort);
    if (q) qs.set('q', q);
    if (category) qs.set('category', category);
    if (inStock) qs.set('inStock', 'true');
    if (use) qs.set('use', use);
    if (colour) qs.set('colour', colour);
    if (conn) qs.set('conn', conn);
    if (water) qs.set('water', water);
    if (battery) qs.set('battery', battery);
    if (ignore) qs.set('ignore', ignore);
    const b = PRICE_BANDS.find((x) => x.key === band);
    if (b?.min !== undefined) qs.set('minPrice', String(b.min));
    if (b?.max !== undefined) qs.set('maxPrice', String(b.max));
    return qs;
  }

  const loadMore = async () => {
    const qs = queryString(page + 1);
    if (!qs || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api<SearchResult>(`/search?${qs}`);
      setMore((m) => {
        const seen = new Set([...(result?.items ?? []), ...m].map((i) => i.productId));
        return [...m, ...r.items.filter((i) => !seen.has(i.productId))];
      });
      setPage((n) => n + 1);
    } catch {
      /* the button stays, so the shopper can try again */
    } finally {
      setLoadingMore(false);
    }
  };

  const items = useMemo(() => [...(result?.items ?? []), ...more], [result, more]);
  // Live stock polls at most 48 ids at once: the cards nearest the top.
  const ids = useMemo(() => items.slice(0, 48).map((i) => i.productId), [items]);
  const live = useLiveStock(city, ids);
  const filtered = Boolean(q || category || band || inStock || use || colour || conn || water || battery || sort !== 'relevance');
  const here = city ? cityName(city) : 'your city';

  const gridRef = useRef<HTMLDivElement>(null);
  useGsap(() => revealCards(), [result], gridRef);

  const title = q ? `Results for “${q}”` : category ? CATEGORY_LABEL[category] ?? category : `Shop ${here}`;
  const categories = result?.facets.categories ?? [];
  const usesFacet = result?.facets.uses ?? [];
  // doc/19: marketplace-style attribute facets, with live counts from OpenSearch aggregations.
  const attrFacets: { key: string; title: string; value: string; options: { key: string; label: string; count: number }[] }[] = [
    { key: 'battery', title: 'Battery life', value: battery, options: (result?.facets.battery ?? []).map((b) => ({ key: b.key, label: Number(b.key) >= 168 ? '7 days +' : `${b.key} h +`, count: b.count })) },
    { key: 'water', title: 'Water resistance', value: water, options: (result?.facets.water ?? []).map((b) => ({ key: b.key, label: b.key === 'splash-proof' ? 'Splash-proof' : b.key, count: b.count })) },
    { key: 'conn', title: 'Connectivity', value: conn, options: (result?.facets.connectivity ?? []).map((b) => ({ key: b.key, label: CONN_LABEL[b.key] ?? b.key, count: b.count })) },
    { key: 'colour', title: 'Colour', value: colour, options: (result?.facets.colours ?? []).map((b) => ({ key: b.key, label: b.key.replace(/^./, (c) => c.toUpperCase()), count: b.count })) },
  ];
  const understood = result?.intent?.understood ?? [];
  const otherCity = result?.city && city && result.city !== city ? result.city : null;
  const dropChip = (key: string) => update({ ignore: [...ignore.split(',').filter(Boolean), key].join(',') });

  return (
    <main className="shell page shop">
      <header className="shop-head">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="muted">
            {result && !error
              ? `${result.total} ${result.total === 1 ? 'product' : 'products'} from our ${here} store, found in ${result.tookMs} ms.`
              : `Products from our ${here} store.`}
          </p>
        </div>
        <SearchBox
          value={text}
          onChange={setText}
          inputRef={input}
          // Enter or a suggestion: search now, without waiting for the typing debounce.
          onSearch={(t) => { setText(t); update({ q: t || null, ignore: null }); }}
          placeholder="Describe what you need: “tea flask for my commute under 800”"
        >
          <kbd className="kbd" aria-hidden="true">/</kbd>
        </SearchBox>
      </header>

      {/* doc/19: what the search understood, as chips the shopper can remove. */}
      {understood.length > 0 && (
        <div className="understood" aria-label="What we understood">
          <span className="understood-label">We understood</span>
          {understood.map((c) => (
            <button key={c.key} className="chip-x" onClick={() => dropChip(c.key)} aria-label={`Remove ${c.label}`}>
              {c.label} <span aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}
      {!q && (
        <div className="try-these" aria-label="Try searching for">
          <span className="understood-label">Try</span>
          {TRY.map((t) => (
            <button key={t} className="try-chip" onClick={() => { setText(t); update({ q: t, ignore: null }); }}>{t}</button>
          ))}
        </div>
      )}
      {result?.intent?.notice && <div className="notice" role="status">{result.intent.notice}</div>}
      {otherCity && (
        <div className="notice other-city" role="status">
          Showing stock in <b>{cityName(otherCity)}</b>. You’re shopping in {here}.{' '}
          <button className="link-btn" onClick={() => setCityTo(otherCity)}>Switch to {cityName(otherCity)}</button>
          {' '}or{' '}
          <button className="link-btn" onClick={() => dropChip('city')}>search {here}</button>
        </div>
      )}

      <div className="shop-layout">
        <aside className="shop-filters" aria-label="Filters">
          <div className="filter-group">
            <h2>Category</h2>
            <div className="filter-options">
              <button className="filter-opt" aria-pressed={!category} onClick={() => update({ category: null })}>
                All categories
              </button>
              {categories.map((c) => (
                <button
                  key={c.key}
                  className="filter-opt"
                  aria-pressed={category === c.key}
                  onClick={() => update({ category: category === c.key ? null : c.key })}
                >
                  {CATEGORY_LABEL[c.key] ?? c.key}
                  <span className="n">{c.count}</span>
                </button>
              ))}
            </div>
          </div>
          {usesFacet.length > 0 && (
            <div className="filter-group">
              <h2>Good for</h2>
              <div className="filter-options">
                {usesFacet.map((u) => (
                  <button key={u.key} className="filter-opt" aria-pressed={use === u.key} onClick={() => update({ use: use === u.key ? null : u.key })}>
                    {u.label}
                    <span className="n">{u.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {attrFacets.filter((f) => f.options.length > 1 || f.value).map((f) => (
            <div key={f.key} className="filter-group">
              <h2>{f.title}</h2>
              <div className="filter-options">
                {f.options.slice(0, 8).map((o) => (
                  <button key={o.key} className="filter-opt" aria-pressed={f.value === o.key} onClick={() => update({ [f.key]: f.value === o.key ? null : o.key })}>
                    {o.label}
                    <span className="n">{o.count}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="filter-group">
            <h2>Price</h2>
            <div className="filter-options">
              {PRICE_BANDS.map((b) => (
                <button
                  key={b.key}
                  className="filter-opt"
                  aria-pressed={band === b.key}
                  onClick={() => update({ price: band === b.key ? null : b.key })}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={inStock} onChange={(e) => update({ inStock: e.target.checked ? 'true' : null })} />
            Hide sold-out products
          </label>
          {filtered && (
            <button className="link-btn" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              Clear all filters
            </button>
          )}
        </aside>

        <div ref={gridRef} className="shop-results">
          {error ? (
            <div className="notice error" role="alert">
              {error.code === 'SEARCH_UNAVAILABLE'
                ? 'Search is catching its breath. Try again in a moment, or open a product from your cart.'
                : error.message}
            </div>
          ) : loading && !result ? (
            <div className="grid">{Array.from({ length: 8 }, (_, i) => <CardSkeleton key={i} />)}</div>
          ) : result && result.items.length === 0 && !result.shops?.length ? (
            <div className="empty-state">
              <h2>Nothing for {q ? `“${q}”` : 'those filters'} in {here}</h2>
              <p className="muted">Try a shorter search or fewer filters.</p>
              {filtered && (
                <button className="btn" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <>
              {result?.shops?.map((sh) => (
                <section key={sh.id} className="shop-match" aria-label={`${sh.name}, partner shop`}>
                  <div className="shop-match-head">
                    <div>
                      <span className="shop-match-tag">Partner shop · {sh.cityName}</span>
                      <h2>{sh.name}</h2>
                      <p className="muted small">★ {sh.rating.toFixed(1)} · {sh.deliveryNote} · <b>{sh.inStock}</b> of {sh.products} products in stock</p>
                    </div>
                    <Link className="btn btn-primary btn-sm" to={`/store/${sh.slug}`}>See all {sh.products} products</Link>
                  </div>
                  <ul className="shop-match-items">
                    {sh.items.map((i) => (
                      <li key={i.productId}>
                        <Link to={`/store/${sh.slug}?q=${encodeURIComponent(i.name)}`} className={`similar-card ${i.inStock ? '' : 'is-out'}`}>
                          <span className="similar-art"><ProductImage imageKey={i.imageKey} productId={i.productId} sku={i.sku} name={i.name} /></span>
                          <span className="similar-name">{i.name}</span>
                          <span className="similar-meta"><b>{inr(i.pricePaise)}</b> · {i.inStock ? `${i.qty} left` : 'Sold out'}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {result?.shops?.length ? <h2 className="results-sub">From the StockHop {here} store</h2> : null}
              <div className="results-bar">
                <span className="muted small">{result ? `Showing ${items.length} of ${result.total}` : ''}</span>
                <label className="sort-select">
                  <span>Sort by</span>
                  <select value={sort} onChange={(e) => update({ sort: e.target.value === 'relevance' ? null : e.target.value })}>
                    {SORTS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </select>
                </label>
              </div>
              <div className={`grid ${loading ? 'is-loading' : ''}`}>
                {items.map((item) => <ProductCard key={item.productId} item={item} live={live.get(item.productId)} />)}
              </div>
              {result && items.length < result.total && (
                <div className="load-more">
                  <button className="btn" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? 'Loading…' : `Show more (${result.total - items.length} left)`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
