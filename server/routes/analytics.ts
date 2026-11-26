import { Router } from 'express';
import { z } from 'zod';
import { analyticsConfig } from '../config.js';
import { getPool } from '../lib/db.js';
import { getSearch } from '../lib/search.js';
import { HttpError, parse } from '../lib/http.js';

/**
 * GET /api/ops/analytics?hours=24: shopper analytics from the activity index (doc/14), all computed
 * by OpenSearch aggregations over the clickstream + order + stock events the analytics worker indexes.
 */
export const analytics = Router();

type Bucket = { key: string | number; doc_count: number; key_as_string?: string };
type Aggs = Record<string, { buckets?: Bucket[]; value?: number; doc_count?: number; [k: string]: unknown }>;

const FUNNEL = [
  { key: 'visitors', label: 'Visitors' },
  { key: 'searched', label: 'Searched' },
  { key: 'viewed', label: 'Viewed a product' },
  { key: 'checkout', label: 'Reached checkout' },
] as const;

analytics.get('/ops/analytics', async (req, res) => {
  const { hours } = parse(z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) }), req.query);
  const { index } = analyticsConfig();
  const since = `now-${hours}h`;
  const distinct = { cardinality: { field: 'visitor' } };
  const body = {
    size: 0,
    query: { range: { at: { gte: since } } },
    aggs: {
      by_type: { terms: { field: 'type', size: 20 } },
      visitors: distinct,
      searched: { filter: { term: { type: 'search' } }, aggs: { v: distinct } },
      viewed: { filter: { bool: { filter: [{ term: { type: 'page_view' } }, { term: { page: '/p/:id' } }] } }, aggs: { v: distinct } },
      checkout: { filter: { bool: { filter: [{ term: { type: 'page_view' } }, { term: { page: '/checkout' } }] } }, aggs: { v: distinct } },
      top_clicks: { filter: { term: { type: 'click' } }, aggs: { t: { terms: { field: 'label', size: 8 } } } },
      top_searches: { filter: { term: { type: 'search' } }, aggs: { t: { terms: { field: 'q', size: 8 } } } },
      // doc/21: what shoppers take from the search dropdown and the "bought together" picks.
      suggest_picks: { filter: { bool: { filter: [{ term: { type: 'click' } }, { prefix: { label: 'suggest-' } }] } }, aggs: { t: { terms: { field: 'label', size: 8 } }, v: distinct } },
      together: { filter: { bool: { filter: [{ term: { type: 'click' } }, { terms: { label: ['together-add', 'together-open', 'cart-addon-add'] } }] } }, aggs: { t: { terms: { field: 'label', size: 4 } } } },
      zero_results: { filter: { bool: { filter: [{ term: { type: 'search' } }, { term: { results: 0 } }] } }, aggs: { t: { terms: { field: 'q', size: 8 } } } },
      top_products: { filter: { bool: { filter: [{ term: { type: 'page_view' } }, { term: { page: '/p/:id' } }] } }, aggs: { t: { terms: { field: 'product_id', size: 5 } } } },
      top_pages: { filter: { term: { type: 'page_view' } }, aggs: { t: { terms: { field: 'page', size: 8 } } } },
      sold_out_seen: { filter: { term: { type: 'sold_out_seen' } }, aggs: { v: distinct } },
      sold_out_moments: { filter: { term: { sold_out: true } } },
      // ── Missed demand: who we turned away, for what, and whether they bought anyway ──
      md_turned: {
        filter: { term: { type: 'sold_out_seen' } },
        aggs: {
          v: distinct,
          by_reason: { terms: { field: 'label', size: 5 } },
          products: { terms: { field: 'product_id', size: 10 }, aggs: { city: { terms: { field: 'city', size: 3 }, aggs: { v: distinct } } } },
          visitors: { terms: { field: 'visitor', size: 1000 }, aggs: { first: { min: { field: 'at' } } } },
        },
      },
      md_sellouts: {
        filter: { term: { sold_out: true } },
        aggs: { products: { terms: { field: 'product_id', size: 10 }, aggs: { city: { terms: { field: 'city', size: 3 } } } } },
      },
      md_rescue_city: { filter: { bool: { filter: [{ term: { type: 'click' } }, { term: { label: 'rescue-city' } }] } }, aggs: { v: distinct } },
      md_rescue_partner: { filter: { bool: { filter: [{ term: { type: 'click' } }, { term: { label: 'rescue-partner' } }] } }, aggs: { v: distinct } },
      md_ordered: {
        filter: { bool: { filter: [{ term: { type: 'page_view' } }, { term: { page: '/orders/:id' } }] } },
        aggs: { visitors: { terms: { field: 'visitor', size: 1000 }, aggs: { last: { max: { field: 'at' } } } } },
      },
      orders: { filter: { term: { type: 'order_placed' } }, aggs: { revenue: { sum: { field: 'total_paise' } }, by_city: { terms: { field: 'city', size: 5 } } } },
      per_minute: {
        filter: { range: { at: { gte: 'now-60m' } } },
        aggs: {
          t: {
            date_histogram: { field: 'at', fixed_interval: '1m', min_doc_count: 0, extended_bounds: { min: 'now-60m', max: 'now' } },
            aggs: { orders: { filter: { term: { type: 'order_placed' } } } },
          },
        },
      },
    },
  };

  let aggs: Aggs;
  try {
    const r = await getSearch().search({ index, body: body as unknown as Record<string, unknown> });
    aggs = (r.body as { aggregations: Aggs }).aggregations;
  } catch (e) {
    const status = (e as { meta?: { statusCode?: number } }).meta?.statusCode;
    if (status === 404) {
      res.json({ ready: false, hours });
      return;
    }
    throw new HttpError(503, 'SEARCH_UNAVAILABLE', 'Analytics are catching their breath. Try again in a moment.');
  }

  const sub = (name: string) => (aggs[name] as unknown as { t: { buckets: Bucket[] } }).t.buckets;
  const uniq = (name: string) => (aggs[name] as unknown as { v: { value: number } }).v.value;

  // Missed demand: merge "shoppers turned away" (clickstream) with "times it sold out" (Kafka stock events) per product × city.
  type CityB = Bucket & { v?: { value: number } };
  type ProdB = Bucket & { city: { buckets: CityB[] } };
  const turned = aggs.md_turned as unknown as {
    doc_count: number; v: { value: number }; by_reason: { buckets: Bucket[] }; products: { buckets: ProdB[] };
    visitors: { buckets: (Bucket & { first: { value: number } })[] };
  };
  const sellouts = (aggs.md_sellouts as unknown as { products: { buckets: ProdB[] } }).products.buckets;
  const demand = new Map<string, { productId: number; city: string; turnedAway: number; soldOuts: number }>();
  const row = (pid: number, city: string) => {
    const k = `${pid}|${city}`;
    if (!demand.has(k)) demand.set(k, { productId: pid, city, turnedAway: 0, soldOuts: 0 });
    return demand.get(k)!;
  };
  for (const p of turned.products.buckets) for (const c of p.city.buckets) row(Number(p.key), String(c.key)).turnedAway = c.v?.value ?? c.doc_count;
  for (const p of sellouts) for (const c of p.city.buckets) row(Number(p.key), String(c.key)).soldOuts = c.doc_count;
  const demandRows = [...demand.values()].sort((a, b) => b.turnedAway - a.turnedAway || b.soldOuts - a.soldOuts).slice(0, 8);
  // "Bought anyway": a turned-away visitor who later reached an order confirmation page.
  const orderedAt = new Map(
    (aggs.md_ordered as unknown as { visitors: { buckets: (Bucket & { last: { value: number } })[] } }).visitors.buckets.map((b) => [String(b.key), b.last.value]),
  );
  const boughtAnyway = turned.visitors.buckets.filter((b) => (orderedAt.get(String(b.key)) ?? 0) > b.first.value).length;

  const productIds = [...new Set([...sub('top_products').map((b) => Number(b.key)), ...demandRows.map((r) => r.productId)])];
  const names = new Map<number, string>();
  if (productIds.length) {
    const { rows } = await getPool().query<{ id: number; name: string }>('SELECT id, name FROM products WHERE id = ANY($1::int[])', [productIds]);
    for (const r of rows) names.set(r.id, r.name);
  }
  const ordersAgg = aggs.orders as unknown as { doc_count: number; revenue: { value: number }; by_city: { buckets: Bucket[] } };

  res.json({
    ready: true,
    hours,
    events: (aggs.by_type?.buckets ?? []).map((b) => ({ type: b.key, count: b.doc_count })),
    visitors: aggs.visitors?.value ?? 0,
    funnel: FUNNEL.map((f) => ({ label: f.label, visitors: f.key === 'visitors' ? (aggs.visitors?.value ?? 0) : uniq(f.key) })),
    orders: { count: ordersAgg.doc_count, revenuePaise: ordersAgg.revenue.value, byCity: ordersAgg.by_city.buckets.map((b) => ({ city: b.key, count: b.doc_count })) },
    soldOut: { visitorsWhoSawIt: uniq('sold_out_seen'), moments: (aggs.sold_out_moments?.doc_count as number) ?? 0 },
    missedDemand: {
      turnedAway: turned.v.value,
      moments: turned.doc_count,
      byReason: turned.by_reason.buckets.map((b) => ({ reason: String(b.key), count: b.doc_count })),
      triedAnotherCity: uniq('md_rescue_city'),
      triedPartner: uniq('md_rescue_partner'),
      boughtAnyway,
      products: demandRows.map((r) => ({ ...r, name: names.get(r.productId) ?? `#${r.productId}` })),
    },
    topClicks: sub('top_clicks').map((b) => ({ label: b.key, count: b.doc_count })),
    topSearches: sub('top_searches').map((b) => ({ q: b.key, count: b.doc_count })),
    suggestions: {
      picks: (aggs.suggest_picks?.doc_count as number) ?? 0,
      visitors: uniq('suggest_picks'),
      byKind: sub('suggest_picks').map((b) => ({ kind: String(b.key).replace('suggest-', ''), count: b.doc_count })),
    },
    together: sub('together').map((b) => ({ label: String(b.key), count: b.doc_count })),
    zeroResultSearches: sub('zero_results').map((b) => ({ q: b.key, count: b.doc_count })),
    topProducts: sub('top_products').map((b) => ({ productId: Number(b.key), name: names.get(Number(b.key)) ?? `#${b.key}`, views: b.doc_count })),
    topPages: sub('top_pages').map((b) => ({ page: b.key, count: b.doc_count })),
    perMinute: sub('per_minute').map((b) => ({ at: b.key_as_string ?? String(b.key), events: b.doc_count, orders: (b as unknown as { orders: { doc_count: number } }).orders.doc_count })),
  });
});
