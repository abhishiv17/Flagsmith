import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePoll } from '../hooks';
import { gsap, reducedMotion } from '../motion';

/** GET /retailer/shop/live (server/lib/presence.ts). */
export interface LiveData {
  at: number;
  source: 'valkey' | 'memory';
  shoppers: number;
  products: { productId: number; name: string; qty: number; pricePaise: number; viewing: number; hovering: number; carting: number; lastAt: number }[];
  feed: { productId: number; name: string; kind: 'view' | 'hover' | 'cart'; at: number; shopper: string }[];
}

const VERB: Record<LiveData['feed'][number]['kind'], string> = {
  view: 'opened',
  hover: 'is eyeing',
  cart: 'added to cart',
};

const since = (now: number, at: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 3 ? 'just now' : s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`;
};

/**
 * Polls the shop's live presence every 2 s. Lifted into the dashboard so the header pill and the
 * product table can use it too.
 */
export function useShopLive(enabled: boolean): LiveData | null {
  const [data, setData] = useState<LiveData | null>(null);
  usePoll(async () => {
    try {
      setData(await api<LiveData>('/retailer/shop/live'));
    } catch {
      /* keep the last answer; the next tick retries */
    }
  }, 2000, enabled);
  return data;
}

/** One product row: flashes when its numbers change. */
function LiveRow({ p, city }: { p: LiveData['products'][number]; city: string }) {
  const ref = useRef<HTMLLIElement>(null);
  const sig = `${p.viewing}/${p.hovering}/${p.carting}`;
  const prev = useRef(sig);
  useEffect(() => {
    if (prev.current === sig) return;
    prev.current = sig;
    if (ref.current && !reducedMotion()) gsap.fromTo(ref.current, { backgroundColor: 'rgba(29,107,71,0.18)' }, { backgroundColor: 'rgba(29,107,71,0)', duration: 1.4 });
  }, [sig]);
  const bits = [
    p.viewing && `${p.viewing} on the page`,
    p.hovering && `${p.hovering} hovering`,
    p.carting && `${p.carting} added to cart`,
  ].filter(Boolean);
  return (
    <li ref={ref} className="live-row">
      <span className="live-row-dot" aria-hidden="true" />
      <span className="live-row-main">
        <Link to={`/p/${p.productId}?city=${city}`}>{p.name}</Link>
        <span className="muted small">{bits.join(' · ')}</span>
      </span>
      <span className={`qty-badge ${p.qty === 0 ? 'out' : p.qty <= 1 ? 'one' : ''}`}>{p.qty === 0 ? 'Sold out' : `${p.qty} on shelf`}</span>
    </li>
  );
}

/** "Live now": who's on, or hovering over, this shop's items this second, and the latest moments. */
export function LiveNow({ data, city, cityName }: { data: LiveData | null; city: string; cityName: string }) {
  return (
    <section className="box tile wide live-now" aria-live="polite">
      <h2 className="tile-title">
        <span className={`live-pill ${data?.shoppers ? '' : 'idle'}`}><span className="dot" />Live now</span>{' '}
        <span className="muted small">
          Shoppers in {cityName} on your items’ pages or hovering over them, updated every 2 s
          {data ? ` · ${data.source === 'valkey' ? 'Aiven for Valkey' : 'this server'}` : ''}
        </span>
      </h2>
      {!data ? (
        <p className="muted small">Connecting…</p>
      ) : (
        <div className="live-grid">
          <div>
            <h3 className="live-sub">{data.shoppers ? `${data.shoppers} ${data.shoppers === 1 ? 'shopper' : 'shoppers'} looking right now` : 'Nobody on your items this second'}</h3>
            {data.products.length ? (
              <ul className="plain live-list">{data.products.map((p) => <LiveRow key={p.productId} p={p} city={city} />)}</ul>
            ) : (
              <p className="muted small">Open one of your items in another window (or hover over it in the shop) and it shows up here.</p>
            )}
          </div>
          <div>
            <h3 className="live-sub">Latest moments</h3>
            {data.feed.length ? (
              <ul className="plain live-feed">
                {data.feed.slice(0, 10).map((f) => (
                  <li key={`${f.at}-${f.shopper}-${f.productId}-${f.kind}`} className={`feed-${f.kind}`}>
                    <span>
                      <b>Shopper {f.shopper}</b> {VERB[f.kind]} <Link to={`/p/${f.productId}?city=${city}`}>{f.name}</Link>
                    </span>
                    <span className="muted small">{since(data.at, f.at)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">Nothing yet in the last hour.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
