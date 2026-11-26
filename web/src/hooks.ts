import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, type LiveItem } from './api';

/** Run `fn` every `ms` while the tab is visible (and once immediately). */
export function usePoll(fn: () => void | Promise<void>, ms: number, enabled = true) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const tick = () => {
      if (!stopped && document.visibilityState === 'visible') void saved.current();
    };
    tick();
    const t = window.setInterval(tick, ms);
    const onVis = () => document.visibilityState === 'visible' && tick();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped = true;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [ms, enabled]);
}

/**
 * One shared 1 s clock for "checked 3 s ago" stamps, so forty cards don't run forty timers.
 * Also remembers when live stock last came back successfully (any card, any page).
 */
const clockSubs = new Set<() => void>();
let clockTimer: number | undefined;
let lastStockCheck: number | null = null;
function subscribeClock(fn: () => void) {
  clockSubs.add(fn);
  clockTimer ??= window.setInterval(() => clockSubs.forEach((f) => f()), 1000);
  return () => {
    clockSubs.delete(fn);
    if (!clockSubs.size && clockTimer !== undefined) {
      window.clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}
const nowSecond = () => Math.floor(Date.now() / 1000);

/** Whole seconds since `at` (ms), re-rendering once a second; null when `at` is null. */
export function useSecondsSince(at: number | null): number | null {
  const now = useSyncExternalStore(subscribeClock, nowSecond);
  return at === null ? null : Math.max(0, now - Math.floor(at / 1000));
}

/** Seconds since live stock was last confirmed by the server; null before the first answer. */
export function useStockCheckedAgo(): number | null {
  useSyncExternalStore(subscribeClock, nowSecond);
  return useSecondsSince(lastStockCheck);
}

/**
 * Live stock for the cards on screen (doc/06 §3): polls /api/stock every 1.5 s.
 * The index behind it is fed by relay → Kafka → indexer, so a sale in another window shows up here.
 *
 * Guards: a new poll cancels the one still in flight; a response for a city or id set we've
 * moved away from is dropped; and an item only updates when its stockVersion goes up, so a
 * slow, out-of-order response can never roll a card back to older stock.
 */
export function useLiveStock(city: string | null, productIds: number[]): Map<number, LiveItem> {
  const [live, setLive] = useState<Map<number, LiveItem>>(new Map());
  const key = productIds.join(',');
  const current = useRef({ city, key });
  current.current = { city, key };
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    setLive(new Map());
    return () => inflight.current?.abort();
  }, [city, key]);

  usePoll(
    async () => {
      if (!city || !key) return;
      inflight.current?.abort();
      const ctrl = new AbortController();
      inflight.current = ctrl;
      try {
        const r = await api<{ items: LiveItem[] }>(`/stock?city=${city}&ids=${key}`, {}, ctrl.signal);
        if (current.current.city !== city || current.current.key !== key) return; // stale request
        lastStockCheck = Date.now();
        setLive((prev) => {
          let next: Map<number, LiveItem> | null = null;
          for (const item of r.items) {
            const cur = prev.get(item.productId);
            if (item.city === city && (!cur || item.stockVersion > cur.stockVersion)) {
              next ??= new Map(prev);
              next.set(item.productId, item);
            }
          }
          return next ?? prev; // same object when nothing changed: no re-render
        });
      } catch {
        /* aborted or transient: keep last known values, next tick retries */
      }
    },
    1500,
    Boolean(city && key),
  );
  return live;
}

/** Debounce a value (search box: 250 ms). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}
