import { useEffect, useRef } from 'react';

/**
 * Live presence for the retailer dashboard (server/lib/presence.ts). Separate from track.ts on
 * purpose: analytics batch every 10 s for history; this sends right away so a shop sees a shopper
 * on its item within a couple of seconds. Only "which product, which city, page or hover", tied to
 * the same one-way visitor hash as the clickstream.
 */

type Kind = 'view' | 'hover' | 'cart';

function currentCity(): string | null {
  try {
    return localStorage.getItem('stockhop.city');
  } catch {
    return null;
  }
}

const lastSent = new Map<string, number>();

/** Send one heartbeat now (at most one per product+kind every `minGapMs`). Never throws. */
export function beat(productId: number, kind: Kind, minGapMs = 3000): void {
  const city = currentCity();
  if (!city || location.pathname.startsWith('/ops') || location.pathname.startsWith('/retailer')) return;
  const key = `${productId}:${kind}`;
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < minGapMs) return;
  lastSent.set(key, now);
  fetch('/api/presence', {
    method: 'POST',
    keepalive: true,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ city, beats: [{ productId, kind }] }),
  }).catch(() => {
    /* presence must never break shopping */
  });
}

/** While a product page is open and visible: a "view" heartbeat every 5 s. */
export function useViewPresence(productId: number | null) {
  useEffect(() => {
    if (!productId) return;
    const tick = () => document.visibilityState === 'visible' && beat(productId, 'view', 4000);
    tick();
    const t = window.setInterval(tick, 5000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [productId]);
}

/**
 * Hover presence for a card: counts once the pointer (or keyboard focus) has rested on it for
 * 350 ms, then every 4 s while it stays. Spread the returned handlers onto the card.
 */
export function useHoverPresence(productId: number) {
  const timer = useRef<number>();
  const repeat = useRef<number>();
  const stop = () => {
    window.clearTimeout(timer.current);
    window.clearInterval(repeat.current);
  };
  useEffect(() => stop, []);
  const start = () => {
    stop();
    timer.current = window.setTimeout(() => {
      beat(productId, 'hover');
      repeat.current = window.setInterval(() => beat(productId, 'hover'), 4000);
    }, 350);
  };
  return { onMouseEnter: start, onMouseLeave: stop, onFocus: start, onBlur: stop };
}
