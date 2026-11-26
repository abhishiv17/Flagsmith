/**
 * Shopper activity tracking (doc/14). Events are queued and sent in batches every 10 s (and when the
 * tab is hidden) to POST /api/track, which writes them to the outbox → Kafka user.activity →
 * OpenSearch, charted on /ops.
 *
 * Privacy: we record which screen and which button, never what anyone typed into a form.
 * Clicks inside <input>, <textarea> or [data-no-track] are ignored.
 */
type Activity = {
  type: 'page_view' | 'product_presence' | 'click' | 'search' | 'sold_out_seen' | 'api_error';
  path?: string;
  city?: string;
  label?: string;
  productId?: number;
  q?: string;
  results?: number;
  code?: string;
};

const queue: (Required<Pick<Activity, 'type'>> & Activity & { at: number; path: string })[] = [];
const MAX_QUEUE = 200;
let started = false;

function currentCity(): string | undefined {
  try {
    return localStorage.getItem('stockhop.city') ?? undefined;
  } catch {
    return undefined;
  }
}

export function track(type: Activity['type'], fields: Omit<Activity, 'type'> = {}): void {
  if (typeof window === 'undefined' || location.pathname.startsWith('/ops')) return;
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push({ type, at: Date.now(), path: location.pathname + location.search, city: currentCity(), ...fields });
}

/** After a 503 (database busy) we pause sending for a minute: shopping traffic comes first. */
let pausedUntil = 0;

function flush(leaving = false): void {
  if (!queue.length || Date.now() < pausedUntil) return;
  const batch = queue.splice(0, 50);
  const body = JSON.stringify({ events: batch });
  if (leaving) {
    // The page is going away: sendBeacon is the only send that reliably survives.
    try {
      if (navigator.sendBeacon?.('/api/track', new Blob([body], { type: 'application/json' }))) return;
    } catch {
      /* fall through */
    }
  }
  fetch('/api/track', { method: 'POST', body, keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json' } })
    .then((r) => {
      if (r.status === 503) {
        pausedUntil = Date.now() + 60_000;
        queue.unshift(...batch.slice(0, MAX_QUEUE - queue.length)); // keep them for later
      }
    })
    .catch(() => {
      /* analytics must never break shopping */
    });
}

/** The visible name of what was clicked: data-track, aria-label, or its text (short, numbers removed). */
function labelOf(el: Element): string | undefined {
  const explicit = (el as HTMLElement).dataset?.track ?? el.getAttribute('aria-label');
  const text = explicit ?? (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const clean = text.replace(/₹\s?[\d,]+/g, '₹…').replace(/\d{4,}/g, '…').slice(0, 60);
  return clean || (el as HTMLAnchorElement).getAttribute?.('href') || undefined;
}

function onClick(ev: MouseEvent): void {
  const target = ev.target as Element | null;
  if (!target?.closest || target.closest('input, textarea, select, [data-no-track]')) return;
  const el = target.closest('button, a, [role="button"], [data-track]');
  if (!el) return;
  const href = el.getAttribute('href') ?? '';
  const m = /^\/p\/(\d+)/.exec(href);
  const tagged = Number((el as HTMLElement).dataset?.product);
  track('click', { label: labelOf(el), productId: m ? Number(m[1]) : tagged > 0 ? tagged : undefined });
}

export function startTracking(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  document.addEventListener('click', onClick, { capture: true, passive: true });
  window.setInterval(() => flush(), 10_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
  window.addEventListener('pagehide', () => flush(true));
}
