import { useState } from 'react';
import { api, cityName } from '../api';
import { usePoll } from '../hooks';

/** The missedDemand part of GET /api/ops/analytics (server/routes/analytics.ts). */
interface MissedDemandData {
  turnedAway: number;
  moments: number;
  byReason: { reason: string; count: number }[];
  triedAnotherCity: number;
  triedPartner: number;
  boughtAnyway: number;
  products: { productId: number; name: string; city: string; turnedAway: number; soldOuts: number }[];
}
interface Resp { ready: boolean; hours: number; missedDemand?: MissedDemandData; zeroResultSearches?: { q: string; count: number }[] }

const REASON: Record<string, string> = {
  sold_out: 'sold out',
  in_someone_cart: 'in someone’s cart',
  being_paid_for: 'being paid for',
  checkout: 'gone at checkout',
};

/**
 * Top of /ops, for the retailer: demand the shop couldn't serve and whether those shoppers were saved
 * (another city, a partner shop, an order anyway). Built from the clickstream (user.activity) and
 * Kafka stock events in OpenSearch (doc/14).
 */
export function MissedDemand() {
  const [d, setD] = useState<Resp | null>(null);
  usePoll(async () => {
    try {
      setD(await api<Resp>('/ops/analytics?hours=24'));
    } catch {
      /* keep the last numbers; the pipeline tiles below show what's wrong */
    }
  }, 10_000);

  const m = d?.missedDemand;
  if (!d?.ready || !m) return null;
  const rescued = m.triedAnotherCity + m.triedPartner;
  // Search-as-you-type sends partial words ("t", "ti"); only real queries count as catalogue gaps.
  const gaps = (d.zeroResultSearches ?? []).filter((g) => g.q.trim().length >= 3);

  return (
    <section className="missed" aria-labelledby="md-title">
      <div className="ops-head an-head">
        <h2 id="md-title" className="an-title">
          Missed demand <span className="muted small">last {d.hours} h · what shoppers wanted that we couldn’t sell them, and what happened next</span>
        </h2>
      </div>
      <div className="ops-grid">
        <section className={`tile box ${m.turnedAway > 0 ? 'warn-tile' : ''}`}>
          <h3 className="tile-title">Shoppers turned away</h3>
          <div className="big">{m.turnedAway}</div>
          <p className="muted small">
            {[`${m.moments} times`, ...m.byReason.map((r) => `${REASON[r.reason] ?? r.reason} ${r.count}`)].join(' · ')}
          </p>
        </section>
        <section className="tile box">
          <h3 className="tile-title">Sent somewhere else</h3>
          <div className="big">{rescued}</div>
          <p className="muted small">{m.triedAnotherCity} to another city · {m.triedPartner} to a partner shop</p>
        </section>
        <section className={`tile box ${m.boughtAnyway > 0 ? 'ok-tile' : ''}`}>
          <h3 className="tile-title">Bought anyway</h3>
          <div className="big">{m.boughtAnyway}</div>
          <p className="muted small">turned-away shoppers who still placed an order{m.turnedAway ? ` (${Math.round((m.boughtAnyway / m.turnedAway) * 100)}%)` : ''}</p>
        </section>
      </div>
      <div className="an-grid">
        <section className="box tile">
          <h3 className="tile-title">Restock here first <span className="muted small">(product × city)</span></h3>
          {m.products.length ? (
            <table className="md-table">
              <thead>
                <tr><th>Product</th><th>City</th><th title="Distinct shoppers told it was sold out or in someone’s cart">Turned away</th><th title="Times stock hit zero after a sale">Sold out</th></tr>
              </thead>
              <tbody>
                {m.products.map((p) => (
                  <tr key={`${p.productId}|${p.city}`}>
                    <td>{p.name}</td><td>{cityName(p.city)}</td><td className="num">{p.turnedAway}</td><td className="num">{p.soldOuts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted small">Nothing has sold out yet.</p>
          )}
        </section>
        <section className="box tile">
          <h3 className="tile-title">Searched for, not stocked <span className="muted small">(no results)</span></h3>
          {gaps.length ? (
            <ul className="md-gaps">
              {gaps.map((g) => <li key={g.q}><span>“{g.q}”</span><span className="num">{g.count}</span></li>)}
            </ul>
          ) : (
            <p className="muted small">Every search found something.</p>
          )}
        </section>
      </div>
    </section>
  );
}
