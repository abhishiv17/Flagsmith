import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, CATEGORY_LABEL, cityName, inr, SORTS, type ShopItem, type ShopPage, type SortKey } from '../api';
import { useCity, useToast } from '../state';
import { useDebounced, usePoll } from '../hooks';
import { stockChanged } from '../motion';
import { ProductImage } from '../components/ProductImage';
import { CardSkeleton, DbStamp } from '../components/ui';
import { useHoverPresence } from '../presence';

/**
 * A partner shop's storefront (/store/:slug): everything it sells, with its own price, how that
 * compares with ours, and its live stock (PostgreSQL, refreshed every 4 s). Searching inside the
 * shop goes through OpenSearch (the shops index: typos, synonyms, as-you-type).
 */
export function Store() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { city, setCity } = useCity();
  const { toast } = useToast();
  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const inStock = params.get('inStock') === 'true';
  const sort = (SORTS.some((x) => x.key === params.get('sort')) ? params.get('sort') : 'relevance') as SortKey;

  const [text, setText] = useState(q);
  const debounced = useDebounced(text, 200);
  const [data, setData] = useState<ShopPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };
  useEffect(() => {
    if (debounced.trim() !== q) update({ q: debounced.trim() || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  useEffect(() => {
    if (q !== text.trim()) setText(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const qs = useMemo(() => {
    const s = new URLSearchParams();
    if (q) s.set('q', q);
    if (category) s.set('category', category);
    if (inStock) s.set('inStock', 'true');
    if (sort !== 'relevance') s.set('sort', sort);
    return s.toString();
  }, [q, category, inStock, sort]);

  // A new search shows its answer straight away; then the shelf refreshes every 4 s.
  const inflight = useRef<AbortController | null>(null);
  const load = async () => {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    try {
      const r = await api<ShopPage>(`/shops/${slug}${qs ? `?${qs}` : ''}`, {}, ctrl.signal);
      setData(r);
      setLoadedAt(Date.now());
      setError(null);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError(e instanceof ApiError && e.status === 404 ? 'We couldn’t find that shop.' : (e as Error).message);
    }
  };
  usePoll(load, 4000);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, qs]);

  if (error && !data) {
    return <main className="shell page"><div className="notice error" role="alert">{error} <Link to="/stores">See all shops</Link></div></main>;
  }
  const shop = data?.shop;
  const elsewhere = shop && city && shop.city !== city;

  const buy = (item: ShopItem) => {
    if (!shop) return;
    // Partner orders are delivered in the shop's own city.
    if (elsewhere) {
      setCity(shop.city);
      toast(`You’re now shopping in ${shop.cityName}`);
    }
    navigate(`/checkout?seller=${shop.id}&product=${item.productId}`);
  };

  return (
    <main className="shell page store-page">
      <nav className="crumbs"><Link to="/stores">Stores</Link> / <span>{shop?.name ?? '…'}</span></nav>
      <header className="store-hero">
        <div>
          <span className="shop-match-tag">Partner shop on StockHop{shop ? ` · ${shop.cityName}` : ''}</span>
          <h1 className="page-title">{shop?.name ?? <span className="sk-line skeleton" style={{ display: 'inline-block', width: 260, height: 48 }} />}</h1>
          {shop && (
            <p className="store-meta">
              <span>★ {shop.rating.toFixed(1)}</span>
              <span>{shop.deliveryNote}</span>
              <DbStamp at={loadedAt} />
            </p>
          )}
        </div>
        {shop && (
          <dl className="store-stats">
            <div><dt>Products</dt><dd>{shop.products}</dd></div>
            <div><dt>In stock now</dt><dd>{shop.inStock}</dd></div>
            <div><dt>Last units</dt><dd className={shop.lastUnits ? 'low' : ''}>{shop.lastUnits}</dd></div>
            {shop.minPricePaise != null && <div><dt>From</dt><dd>{inr(shop.minPricePaise)}</dd></div>}
          </dl>
        )}
      </header>

      {elsewhere && (
        <div className="notice" role="status">
          {shop.name} delivers in {shop.cityName}. You’re shopping in {cityName(city)}.{' '}
          <button className="link-btn" onClick={() => setCity(shop.city)}>Switch to {shop.cityName}</button> to buy from them.
        </div>
      )}

      <div className="store-tools">
        <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); update({ q: text.trim() || null }); }}>
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={shop ? `Search ${shop.name}…` : 'Search this shop…'}
            aria-label="Search this shop"
            maxLength={100}
            data-no-track
          />
        </form>
        <label className="toggle">
          <input type="checkbox" checked={inStock} onChange={(e) => update({ inStock: e.target.checked ? 'true' : null })} />
          In stock only
        </label>
        <label className="sort-select">
          <span>Sort by</span>
          <select value={sort} onChange={(e) => update({ sort: e.target.value === 'relevance' ? null : e.target.value })}>
            {SORTS.map((x) => <option key={x.key} value={x.key}>{x.key === 'relevance' ? (q ? 'Best match' : 'In stock first') : x.label}</option>)}
          </select>
        </label>
      </div>

      {data && data.categories.length > 1 && (
        <div className="filter-options store-cats" role="group" aria-label="Category">
          <button className="filter-opt" aria-pressed={!category} onClick={() => update({ category: null })}>All</button>
          {data.categories.map((c) => (
            <button key={c.key} className="filter-opt" aria-pressed={category === c.key} onClick={() => update({ category: category === c.key ? null : c.key })}>
              {CATEGORY_LABEL[c.key] ?? c.key} <span className="n">{c.count}</span>
            </button>
          ))}
        </div>
      )}

      <p className="muted small store-count">
        {data
          ? `${data.items.length} ${data.items.length === 1 ? 'product' : 'products'}${q ? ` matching “${q}”` : ''}${data.matchedBy === 'opensearch' ? `, found by OpenSearch in ${data.tookMs} ms` : ''}`
          : ' '}
      </p>

      {!data ? (
        <div className="grid">{Array.from({ length: 8 }, (_, i) => <CardSkeleton key={i} />)}</div>
      ) : data.items.length === 0 ? (
        <div className="empty-state">
          <h2>Nothing{q ? ` for “${q}”` : ''} at {shop?.name}</h2>
          <p className="muted">Try another word, or search every shop.</p>
          <Link className="btn" to={q ? `/shop?q=${encodeURIComponent(q)}` : '/shop'}>Search all of StockHop</Link>
        </div>
      ) : (
        <div className="grid">
          {data.items.map((i) => <ShopItemCard key={i.productId} item={i} shopName={shop!.name} onBuy={() => buy(i)} />)}
        </div>
      )}
    </main>
  );
}

function ShopItemCard({ item, shopName, onBuy }: { item: ShopItem; shopName: string; onBuy: () => void }) {
  const cardRef = useRef<HTMLElement>(null);
  const qtyRef = useRef<HTMLSpanElement>(null);
  const prev = useRef(item.qty);
  const hover = useHoverPresence(item.productId);
  // Someone bought from this shop while you were looking: the count flashes.
  useEffect(() => {
    if (prev.current === item.qty) return;
    prev.current = item.qty;
    stockChanged(cardRef.current, qtyRef.current);
  }, [item.qty]);
  const diff = item.pricePaise - item.ourPricePaise;
  return (
    <article className={`card ${item.inStock ? '' : 'oos'}`} ref={cardRef} {...hover}>
      <div className="card-media">
        <span className="live-ring" aria-hidden="true" />
        <Link to={`/p/${item.productId}`} className="card-art-link" tabIndex={-1} aria-hidden="true">
          <ProductImage imageKey={item.imageKey} productId={item.productId} sku={item.sku} name={item.name} />
        </Link>
        {!item.inStock && <span className="tag-oos">Sold out at {shopName}</span>}
      </div>
      <div className="card-body">
        <Link to={`/p/${item.productId}`} className="card-name">{item.name}</Link>
        <span className="card-meta">{item.brand} · {CATEGORY_LABEL[item.category] ?? item.category}</span>
        <span className="price">
          {inr(item.pricePaise)}
          {diff !== 0 && <small className={`price-diff ${diff < 0 ? 'cheaper' : ''}`}>{diff < 0 ? `${inr(-diff)} less than StockHop` : `${inr(diff)} more than StockHop`}</small>}
        </span>
        <p className={`stock ${item.inStock && item.qty <= 2 ? 'low' : ''} ${item.inStock ? '' : 'oos'}`}>
          {item.inStock ? <>{item.qty <= 2 && 'Only '}<span className="qty" ref={qtyRef}>{item.qty}</span> left at {shopName}</> : <strong>Sold out at {shopName}</strong>}
        </p>
        <p className="card-seller">Sold by <b>{shopName}</b></p>
        <button className="btn btn-sm btn-primary card-buy" data-track="shop-buy" data-product={item.productId} onClick={onBuy} disabled={!item.inStock}>
          {item.inStock ? 'Buy from this shop' : 'Sold out'}
        </button>
      </div>
    </article>
  );
}
