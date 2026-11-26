import { useEffect, useState } from 'react';
import { api, inr } from '../api';

type Prices = {
  minPaise: number;
  maxPaise: number;
  cities: {
    code: string; city: string; ownPricePaise: number; ownQty: number;
    partnerMinPaise: number | null; partnerMaxPaise: number | null; partnerSellers: number; partnerQty: number;
  }[];
};

/**
 * Same product, every city (doc/16): our chain-wide price next to what partner shops charge in each
 * city, so the shopper (and the retailer) can see the price range at a glance. From PostgreSQL.
 */
export function PriceAcrossCities({ productId, city }: { productId: number; city: string }) {
  const [data, setData] = useState<Prices | null>(null);
  useEffect(() => {
    let live = true;
    api<Prices>(`/products/${productId}/prices`).then((d) => live && setData(d)).catch(() => {});
    return () => { live = false; };
  }, [productId]);
  if (!data || data.minPaise === data.maxPaise) return null;
  const range = (lo: number | null, hi: number | null) => (lo == null ? '—' : lo === hi ? inr(lo) : `${inr(lo)}–${inr(hi!)}`);
  return (
    <table className="stock-table price-cities">
      <caption>
        Price across cities <span className="muted">{inr(data.minPaise)} to {inr(data.maxPaise)}</span>
      </caption>
      <thead>
        <tr><th scope="col">City</th><th scope="col">StockHop</th><th scope="col">Partner shops</th></tr>
      </thead>
      <tbody>
        {data.cities.map((c) => (
          <tr key={c.code} className={c.code === city ? 'current' : ''}>
            <th scope="row">{c.city}{c.code === city && <span className="you"> (you)</span>}</th>
            <td>{inr(c.ownPricePaise)}{c.ownQty === 0 && <span className="muted small"> · sold out</span>}</td>
            <td className={c.partnerMinPaise != null && c.partnerMinPaise === data.minPaise ? 'cheapest' : ''}>
              {range(c.partnerMinPaise, c.partnerMaxPaise)}
              {c.partnerSellers > 0 && <span className="muted small"> · {c.partnerSellers} shop{c.partnerSellers > 1 ? 's' : ''}</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
