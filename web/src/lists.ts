import { useSyncExternalStore } from 'react';

/**
 * Per-shopper lists kept in this browser: saved items (wishlist), recently viewed products and
 * recent searches. Conveniences only: if storage is blocked (private window) they still work for
 * the visit, they just don't survive a reload. Stock and price are always re-read live; the stored
 * snapshot is only enough to draw the card before that answer arrives.
 */

export interface ProductSnap {
  productId: number; sku: string; name: string; brand: string; category: string; pricePaise: number; imageKey: string;
  at: number;
}

function store<T>(key: string, max: number) {
  let value: T[] = [];
  try {
    const raw = localStorage.getItem(key);
    if (raw) value = (JSON.parse(raw) as T[]).slice(0, max);
  } catch {
    /* blocked or corrupt: start empty */
  }
  const subs = new Set<() => void>();
  const set = (next: T[]) => {
    value = next.slice(0, max);
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* convenience only */
    }
    subs.forEach((f) => f());
  };
  // Another tab changed it.
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (e.key !== key) return;
      try {
        value = e.newValue ? (JSON.parse(e.newValue) as T[]).slice(0, max) : [];
      } catch {
        value = [];
      }
      subs.forEach((f) => f());
    });
  }
  return {
    get: () => value,
    set,
    subscribe: (f: () => void) => {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

const saved = store<ProductSnap>('stockhop.saved', 60);
const viewed = store<ProductSnap>('stockhop.viewed', 12);
const searches = store<string>('stockhop.searches', 8);

const snap = (p: Omit<ProductSnap, 'at'>): ProductSnap => ({
  productId: p.productId, sku: p.sku, name: p.name, brand: p.brand, category: p.category, pricePaise: p.pricePaise, imageKey: p.imageKey, at: Date.now(),
});

/* ---------- saved (wishlist) ---------- */

export function useSaved() {
  const items = useSyncExternalStore(saved.subscribe, saved.get);
  return {
    items,
    has: (id: number) => items.some((i) => i.productId === id),
    /** Add or remove; returns true when it's now saved. */
    toggle: (p: Omit<ProductSnap, 'at'>): boolean => {
      const cur = saved.get();
      if (cur.some((i) => i.productId === p.productId)) {
        saved.set(cur.filter((i) => i.productId !== p.productId));
        return false;
      }
      saved.set([snap(p), ...cur]);
      return true;
    },
    remove: (id: number) => saved.set(saved.get().filter((i) => i.productId !== id)),
  };
}

/* ---------- recently viewed ---------- */

export function noteViewed(p: Omit<ProductSnap, 'at'>) {
  viewed.set([snap(p), ...viewed.get().filter((i) => i.productId !== p.productId)]);
}
export const useViewed = () => useSyncExternalStore(viewed.subscribe, viewed.get);
export const clearViewed = () => viewed.set([]);

/* ---------- recent searches ---------- */

export function noteSearch(q: string) {
  const t = q.trim().replace(/\s+/g, ' ');
  if (t.length < 2) return;
  searches.set([t, ...searches.get().filter((s) => s.toLowerCase() !== t.toLowerCase())]);
}
export const useRecentSearches = () => useSyncExternalStore(searches.subscribe, searches.get);
export const forgetSearch = (q: string) => searches.set(searches.get().filter((s) => s !== q));
export const clearSearches = () => searches.set([]);
