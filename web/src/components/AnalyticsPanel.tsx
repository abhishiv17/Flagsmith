import { useState } from 'react';
import { api, cityName } from '../api';
import { usePoll } from '../hooks';

/** Shape of GET /api/ops/analytics (server/routes/analytics.ts). */
interface Analytics {
  ready: boolean;
  hours: number;
  visitors?: number;
  events?: { type: string; count: number }[];
  funnel?: { label: string; visitors: number }[];
  orders?: { count: number; revenuePaise: number; byCity: { city: string; count: number }[] };
  soldOut?: { visitorsWhoSawIt: number; moments: number };
  topClicks?: { label: string; count: number }[];
  topSearches?: { q: string; count: number }[];
  zeroResultSearches?: { q: string; count: number }[];
  suggestions?: { picks: number; visitors: number; byKind: { kind: string; count: number }[] };
  together?: { label: string; count: number }[];
  topProducts?: { productId: number; name: string; views: number }[];
  topPages?: { page: string; count: number }[];
  perMinute?: { at: string; events: number; orders: number }[];
}

const inr = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;

const SUGGEST_KIND: Record<string, string> = {
  completion: 'Completed words', product: 'A product', shop: 'A shop', category: 'A category',
  recent: 'A recent search', popular: 'Popular (fixed list)', trending: 'Trending this week',
};
const TOGETHER_LABEL: Record<string, string> = {
  'together-add': 'Added the bundle', 'together-open': 'Opened a pick', 'cart-addon-add': 'Added from cart',
};

function Bars({ rows, empty }: { rows: { label: string; value: number }[]; empty: string }) {
  if (!rows.length) return <p className="muted small">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="an-bars">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="an-label" title={r.label}>{r.label}</span>
          <span className="an-track"><span className="an-fill" style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <span className="an-val">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}

function Activity({ points }: { points: { events: number; orders: number }[] }) {
  const w = 600;
  const h = 64;
  const max = Math.max(...points.map((p) => p.events), 1);
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const y = (v: number) => h - 4 - (v / max) * (h - 10);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${y(p.events).toFixed(1)}`).join(' ');
  return (
    <svg className="an-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Shopper events per minute, last hour">
      <path d={`${line} L${w},${h} L0,${h} Z`} fill="currentColor" opacity="0.12" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      {points.map((p, i) => (p.orders ? <circle key={i} cx={i * step} cy={y(p.events)} r="3.5" className="an-order-dot" /> : null))}
    </svg>
  );
}

/** Shopper analytics on /ops: clickstream → Kafka → OpenSearch, aggregated live (doc/14). */
export function AnalyticsPanel() {
  const [a, setA] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  usePoll(async () => {
    try {
      setA(await api<Analytics>('/ops/analytics?hours=24'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, 10_000);

  if (!a) {
    return (
      <section className="box tile wide">
        <h2 className="tile-title">Shopper analytics</h2>
        <p className="muted">{error ?? 'Loading…'}</p>
      </section>
    );
  }
  if (!a.ready) {
    return (
      <section className="box tile wide">
        <h2 className="tile-title">Shopper analytics</h2>
        <p className="muted">No activity indexed yet. Start the analytics worker (<code>npm run workers</code>) and browse the shop.</p>
      </section>
    );
  }

  const funnel = a.funnel ?? [];
  const top = funnel[0]?.visitors || 1;
  return (
    <section className="analytics" aria-labelledby="an-title">
      <div className="ops-head an-head">
        <h2 id="an-title" className="an-title">Shopper analytics <span className="muted small">last {a.hours} h · browser → outbox → Kafka <code>user.activity</code> → OpenSearch</span></h2>
      </div>

      <div className="ops-grid">
        <section className="tile box">
          <h2 className="tile-title">Visitors</h2>
          <div className="big">{a.visitors ?? 0}</div>
          <p className="muted small">{(a.events ?? []).reduce((n, e) => n + e.count, 0)} events</p>
        </section>
        <section className="tile box">
          <h2 className="tile-title">Orders</h2>
          <div className="big">{a.orders?.count ?? 0}</div>
          <p className="muted small">{inr(a.orders?.revenuePaise ?? 0)} · {(a.orders?.byCity ?? []).map((c) => `${cityName(c.city)} ${c.count}`).join(' · ') || 'none yet'}</p>
        </section>
        <section className={`tile box ${(a.soldOut?.visitorsWhoSawIt ?? 0) > 0 ? 'warn-tile' : ''}`}>
          <h2 className="tile-title">Lost the race</h2>
          <div className="big">{a.soldOut?.visitorsWhoSawIt ?? 0}</div>
          <p className="muted small">visitors told “sold out” · {a.soldOut?.moments ?? 0} items sold out</p>
        </section>
        <section className="tile box">
          <h2 className="tile-title">Last hour</h2>
          <Activity points={a.perMinute ?? []} />
          <p className="muted small">events per minute · dots = orders</p>
        </section>
      </div>

      <div className="an-grid">
        <section className="box tile">
          <h2 className="tile-title">Funnel <span className="muted small">(distinct visitors)</span></h2>
          <ol className="an-funnel">
            {funnel.map((f) => (
              <li key={f.label}>
                <span className="an-label">{f.label}</span>
                <span className="an-track"><span className="an-fill" style={{ width: `${(f.visitors / top) * 100}%` }} /></span>
                <span className="an-val">{f.visitors} <span className="muted">{Math.round((f.visitors / top) * 100)}%</span></span>
              </li>
            ))}
          </ol>
        </section>
        <section className="box tile">
          <h2 className="tile-title">Most clicked</h2>
          <Bars rows={(a.topClicks ?? []).map((c) => ({ label: c.label, value: c.count }))} empty="No clicks yet." />
        </section>
        <section className="box tile">
          <h2 className="tile-title">Top searches</h2>
          <Bars rows={(a.topSearches ?? []).map((s) => ({ label: s.q, value: s.count }))} empty="No searches yet." />
        </section>
        <section className="box tile">
          <h2 className="tile-title">Search suggestions taken <span className="muted small">({a.suggestions?.picks ?? 0} picks by {a.suggestions?.visitors ?? 0} shoppers)</span></h2>
          <Bars rows={(a.suggestions?.byKind ?? []).map((s) => ({ label: SUGGEST_KIND[s.kind] ?? s.kind, value: s.count }))} empty="Nobody has picked a suggestion yet." />
        </section>
        <section className="box tile">
          <h2 className="tile-title">Bought together <span className="muted small">(product page and cart picks)</span></h2>
          <Bars rows={(a.together ?? []).map((s) => ({ label: TOGETHER_LABEL[s.label] ?? s.label, value: s.count }))} empty="No picks used yet." />
        </section>
        <section className="box tile">
          <h2 className="tile-title">Searches with no results <span className="muted small">(catalogue gaps)</span></h2>
          <Bars rows={(a.zeroResultSearches ?? []).map((s) => ({ label: s.q, value: s.count }))} empty="Every search found something." />
        </section>
        <section className="box tile">
          <h2 className="tile-title">Most viewed products</h2>
          <Bars rows={(a.topProducts ?? []).map((p) => ({ label: p.name, value: p.views }))} empty="No product views yet." />
        </section>
        <section className="box tile">
          <h2 className="tile-title">Screens</h2>
          <Bars rows={(a.topPages ?? []).map((p) => ({ label: p.page, value: p.count }))} empty="No page views yet." />
        </section>
      </div>
    </section>
  );
}
