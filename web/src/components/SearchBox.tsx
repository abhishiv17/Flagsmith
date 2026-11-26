import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, CATEGORY_LABEL, cityName, inr, type Suggestions } from '../api';
import { track } from '../track';
import { useCity } from '../state';
import { clearSearches, forgetSearch, noteSearch, useRecentSearches } from '../lists';
import { ProductImage } from './ProductImage';

/** Shown when the box is empty and there's no history yet. */
export const POPULAR_SEARCHES = [
  'wireless earbuds',
  'power bank',
  'keep my tea hot on the commute under 800',
  'gift for dad under 2000',
  'waterproof speaker',
  'smartwatch',
];

/** Real trending searches per city (GET /suggest with an empty q), kept for a minute. */
const trendCache = new Map<string, { at: number; items: string[] }>();

type Option =
  | { kind: 'recent' | 'popular' | 'completion'; text: string; count?: number }
  | { kind: 'product'; item: Suggestions['products'][number] }
  | { kind: 'category'; key: string; count: number }
  | { kind: 'shop'; shop: Suggestions['shops'][number] };

const optionKey = (o: Option) =>
  o.kind === 'product' ? `p${o.item.productId}` : o.kind === 'category' ? `c${o.key}` : o.kind === 'shop' ? `s${o.shop.slug}` : `${o.kind}:${o.text}`;

/** "pho" in "phone stand": what you typed in normal weight, the rest bold (how big shops do it). */
function Completion({ typed, text }: { typed: string; text: string }) {
  const t = typed.trim().toLowerCase();
  if (t && text.toLowerCase().startsWith(t)) {
    return <span className="sb-comp"><span className="sb-typed">{text.slice(0, t.length)}</span><b>{text.slice(t.length)}</b></span>;
  }
  return <span className="sb-comp"><b>{text}</b></span>;
}

/** Marks every word of `name` that starts with a typed word. */
function Marked({ name, typed }: { name: string; typed: string }) {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return <>{name}</>;
  return (
    <>
      {name.split(/(\s+)/).map((part, i) => {
        const w = words.find((x) => part.toLowerCase().startsWith(x));
        return w ? <span key={i}><mark>{part.slice(0, w.length)}</mark>{part.slice(w.length)}</span> : <span key={i}>{part}</span>;
      })}
    </>
  );
}

/**
 * The search box with suggestions under it. As you type: completions of your words, matching
 * products (with live price and stock), categories and partner shops. Empty: your recent searches,
 * then popular ones. Arrow keys move, Enter picks, Escape closes.
 */
export function SearchBox({
  value, onChange, onSearch, variant = 'shop', placeholder, inputRef, label = 'Search products', autoFocus, children,
}: {
  /** Controlled text (the Shop page keeps it in the URL); omit to let the box hold its own. */
  value?: string;
  onChange?: (v: string) => void;
  /** Run a search for this text. Defaults to opening /shop?q=. */
  onSearch?: (q: string) => void;
  variant?: 'hero' | 'header' | 'shop';
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
  label?: string;
  autoFocus?: boolean;
  /** Extra content inside the box after the input (a kbd hint, a button). */
  children?: ReactNode;
}) {
  const navigate = useNavigate();
  const { city } = useCity();
  const [own, setOwn] = useState('');
  const text = value ?? own;
  const setText = (v: string) => (onChange ? onChange(v) : setOwn(v));
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [sugg, setSugg] = useState<Suggestions | null>(null);
  const [loading, setLoading] = useState(false);
  const recent = useRecentSearches();
  const listId = useId();
  const boxRef = useRef<HTMLDivElement>(null);

  // Fetch suggestions as the shopper types (120 ms debounce, older requests cancelled).
  useEffect(() => {
    const q = text.trim();
    if (!open || !city || !q) {
      setSugg(null);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = window.setTimeout(() => {
      api<Suggestions>(`/suggest?city=${city}&q=${encodeURIComponent(text.slice(0, 60))}`, {}, ctrl.signal)
        .then((s) => { setSugg(s); setActive(-1); }, () => {})
        .finally(() => !ctrl.signal.aborted && setLoading(false));
    }, 120);
    return () => { window.clearTimeout(t); ctrl.abort(); };
  }, [text, city, open]);

  // Empty box: what shoppers in this city are searching this week (falls back to a fixed list).
  const [trending, setTrending] = useState<string[]>([]);
  useEffect(() => {
    if (!open || !city || text.trim()) return;
    const hit = trendCache.get(city);
    if (hit && Date.now() - hit.at < 60_000) { setTrending(hit.items); return; }
    const ctrl = new AbortController();
    api<Suggestions>(`/suggest?city=${city}&q=`, {}, ctrl.signal).then((s) => {
      const items = (s.trending ?? []).map((t) => t.q);
      trendCache.set(city, { at: Date.now(), items });
      setTrending(items);
    }, () => {});
    return () => ctrl.abort();
  }, [open, city, text]);
  const isTrending = trending.length >= 3;

  // Close when focus or a click goes elsewhere.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const options: Option[] = useMemo(() => {
    if (!text.trim()) {
      const r: Option[] = recent.slice(0, 6).map((t) => ({ kind: 'recent', text: t }));
      const p: Option[] = (isTrending ? trending : POPULAR_SEARCHES).filter((t) => !recent.includes(t)).slice(0, r.length ? 3 : 6).map((t) => ({ kind: 'popular', text: t }));
      return [...r, ...p];
    }
    if (!sugg) return [];
    const typed = text.trim().toLowerCase();
    const cats = Object.entries(CATEGORY_LABEL)
      .filter(([k, label]) => label.toLowerCase().split(/[\s&]+/).some((w) => w && w.startsWith(typed)) || k.startsWith(typed))
      .map(([key]) => ({ kind: 'category' as const, key, count: sugg.categories.find((c) => c.key === key)?.count ?? 0 }));
    const fromHits = sugg.categories.filter((c) => !cats.some((x) => x.key === c.key)).slice(0, Math.max(0, 2 - cats.length))
      .map((c) => ({ kind: 'category' as const, key: c.key, count: c.count }));
    return [
      ...sugg.completions.map((c) => ({ kind: 'completion' as const, text: c.text, count: c.count })),
      ...sugg.shops.map((s) => ({ kind: 'shop' as const, shop: s })),
      ...sugg.products.map((p) => ({ kind: 'product' as const, item: p })),
      ...[...cats, ...fromHits].slice(0, 3),
    ];
  }, [text, sugg, recent, trending, isTrending]);

  const runSearch = (q: string) => {
    const t = q.trim();
    setOpen(false);
    setActive(-1);
    if (t) noteSearch(t);
    if (onSearch) onSearch(t);
    else navigate(t ? `/shop?q=${encodeURIComponent(t)}` : '/shop');
  };

  const pick = (o: Option) => {
    setOpen(false);
    setActive(-1);
    // Analytics (doc/14): which kind of suggestion shoppers take, and for what they typed.
    track('click', {
      label: `suggest-${o.kind === 'popular' && isTrending ? 'trending' : o.kind}`,
      q: o.kind === 'recent' || o.kind === 'popular' ? undefined : text.trim().slice(0, 80) || undefined,
      productId: o.kind === 'product' ? o.item.productId : undefined,
    });
    switch (o.kind) {
      case 'product':
        if (text.trim()) noteSearch(text);
        navigate(`/p/${o.item.productId}`);
        break;
      case 'category':
        navigate(`/shop?category=${o.key}`);
        break;
      case 'shop':
        navigate(`/store/${o.shop.slug}`);
        break;
      default:
        setText(o.text);
        runSearch(o.text);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (!options.length) return;
      // -1 is the input itself: Down from the last option, or Up from the first, returns to it.
      const n = options.length;
      setActive((i) => (e.key === 'ArrowDown' ? (i + 1 >= n ? -1 : i + 1) : (i - 1 < -1 ? n - 1 : i - 1)));
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); setOpen(false); setActive(-1); }
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const o = options[active];
    if (open && o) pick(o);
    else runSearch(text);
  };

  const showPanel = open && (options.length > 0 || (Boolean(text.trim()) && !loading && sugg !== null));
  const activeId = active >= 0 && options[active] ? `${listId}-${active}` : undefined;
  const typed = text.trim();

  // Group headers between kinds.
  const heading = (o: Option, i: number) => {
    if (options[i - 1]?.kind === o.kind) return null;
    const titles: Record<Option['kind'], string | null> = {
      recent: 'Recent searches', popular: isTrending && city ? `Trending in ${cityName(city)} this week` : 'Popular right now', completion: null, product: 'On the shelf', category: 'Categories', shop: 'Shops',
    };
    const t = titles[o.kind];
    if (!t) return null;
    return (
      <li key={`h-${o.kind}`} className="sb-head" role="presentation">
        <span>{t}</span>
        {o.kind === 'recent' && (
          <button type="button" className="sb-clear" onMouseDown={(e) => e.preventDefault()} onClick={() => clearSearches()}>Clear</button>
        )}
      </li>
    );
  };

  return (
    <div className={`sb sb-${variant}`} ref={boxRef}>
      <form className={variant === 'hero' ? 'r-search' : 'search'} role="search" onSubmit={onSubmit}>
        <input
          ref={inputRef}
          type="search"
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => { setText(e.target.value); setOpen(true); setActive(-1); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={label}
          maxLength={100}
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          autoComplete="off"
          enterKeyHint="search"
          data-no-track
        />
        {children}
      </form>
      {showPanel && (
        <div className="sb-panel">
          {options.length === 0 ? (
            <p className="sb-empty">No quick matches. Press Enter to search for “{typed}”: we also understand sentences.</p>
          ) : (
            <ul id={listId} role="listbox" aria-label="Search suggestions" className="sb-list">
              {options.map((o, i) => {
                const props = {
                  id: `${listId}-${i}`,
                  role: 'option' as const,
                  'aria-selected': i === active,
                  className: `sb-opt sb-${o.kind} ${i === active ? 'is-active' : ''}`,
                  // Keep focus in the input so the click lands before the panel closes.
                  onMouseDown: (e: MouseEvent) => e.preventDefault(),
                  onMouseEnter: () => setActive(i),
                  onClick: () => pick(o),
                };
                return [
                  heading(o, i),
                  <li key={optionKey(o)} {...props}>
                    {o.kind === 'product' ? (
                      <>
                        <span className="sb-thumb"><ProductImage imageKey={o.item.imageKey} productId={o.item.productId} sku={o.item.sku} name="" /></span>
                        <span className="sb-main">
                          <span className="sb-name"><Marked name={o.item.name} typed={typed} /></span>
                          <span className="sb-sub">{o.item.brand} · {CATEGORY_LABEL[o.item.category] ?? o.item.category}</span>
                        </span>
                        <span className="sb-side">
                          <b>{inr(o.item.pricePaise)}</b>
                          <span className={o.item.inStock ? (o.item.qty <= 2 ? 'sb-low' : 'sb-ok') : 'sb-out'}>
                            {o.item.inStock ? `${o.item.qty} left` : 'Sold out here'}
                          </span>
                        </span>
                      </>
                    ) : o.kind === 'shop' ? (
                      <>
                        <span className="sb-icon sb-icon-shop" aria-hidden="true" />
                        <span className="sb-main">
                          <span className="sb-name"><Marked name={o.shop.name} typed={typed} /></span>
                          <span className="sb-sub">Partner shop · {o.shop.cityName} · {o.shop.inStock} of {o.shop.products} in stock</span>
                        </span>
                        <span className="sb-go" aria-hidden="true">Visit shop →</span>
                      </>
                    ) : o.kind === 'category' ? (
                      <>
                        <span className="sb-icon sb-icon-cat" aria-hidden="true" />
                        <span className="sb-main"><span className="sb-name">in <b>{CATEGORY_LABEL[o.key] ?? o.key}</b></span></span>
                        {o.count > 0 && <span className="sb-count">{o.count}</span>}
                      </>
                    ) : (
                      <>
                        <span className={`sb-icon sb-icon-${o.kind === 'recent' ? 'recent' : 'search'}`} aria-hidden="true" />
                        <span className="sb-main">{o.kind === 'completion' ? <Completion typed={text} text={o.text} /> : <span className="sb-name">{o.text}</span>}</span>
                        {o.kind === 'completion' && o.count ? <span className="sb-count">{o.count}</span> : null}
                        {o.kind === 'recent' && (
                          <button type="button" className="sb-x" aria-label={`Remove ${o.text} from recent searches`}
                            onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); forgetSearch(o.text); }}>×</button>
                        )}
                      </>
                    )}
                  </li>,
                ];
              })}
            </ul>
          )}
          {typed && (
            <button type="button" className="sb-all" onMouseDown={(e) => e.preventDefault()} onClick={() => runSearch(text)}>
              See all results for “{typed}” →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
