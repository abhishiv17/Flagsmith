import { chEnabled, chQuery } from './clickhouse.js';
import { goesWith, productsInCity, type SearchItem } from './search-query.js';
import { errMsg, log } from './log.js';

/**
 * "Frequently bought together" (product page) and "Goes well with your cart" (cart page).
 *
 *   1. ClickHouse: products that were in the same orders as these (order_lines, every city), most
 *      orders first. Analytics doing a shopper-facing job.
 *   2. Kept only if on the shelf in the shopper's city (OpenSearch mget, the same documents search uses).
 *   3. Not enough? Topped up with complements from OpenSearch: same occasion, another category.
 *
 * Co-purchase counts change slowly, so they're kept in memory for 5 minutes per product set.
 */

export interface Together {
  items: (SearchItem & { basis: 'orders' | 'goes-with'; orders?: number })[];
  /** Units of this product bought in this city over the last 7 days (live orders only; product page). */
  boughtWeek: number | null;
  tookMs: number;
}

const TTL_MS = 5 * 60_000;
const pairsCache = new Map<string, { at: number; rows: Promise<{ pid: number; orders: number }[]> }>();

function coPurchases(ids: number[]): Promise<{ pid: number; orders: number }[]> {
  if (!chEnabled()) return Promise.resolve([]);
  const key = [...ids].sort((a, b) => a - b).join(',');
  const hit = pairsCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  const list = `[${key}]`;
  const rows = chQuery<{ pid: number; orders: string }>(
    `SELECT b.product_id AS pid, uniqExact(a.order_id) AS orders
       FROM order_lines AS a FINAL
       INNER JOIN order_lines AS b FINAL ON a.order_id = b.order_id
      WHERE a.product_id IN {ids:Array(UInt32)} AND b.product_id NOT IN {ids:Array(UInt32)}
      GROUP BY pid ORDER BY orders DESC, pid LIMIT 24`,
    { ids: list },
  )
    .then((r) => r.map((x) => ({ pid: Number(x.pid), orders: Number(x.orders) })))
    .catch((e) => {
      log.warn('together: ClickHouse co-purchase query failed', { err: errMsg(e) });
      pairsCache.delete(key);
      return [];
    });
  if (pairsCache.size > 500) pairsCache.clear();
  pairsCache.set(key, { at: Date.now(), rows });
  return rows;
}

const weekCache = new Map<string, { at: number; n: Promise<number | null> }>();

function boughtThisWeek(productId: number, city: string): Promise<number | null> {
  if (!chEnabled()) return Promise.resolve(null);
  const key = `${productId}:${city}`;
  const hit = weekCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.n;
  // Real orders only (source 'live'); the seeded demo history never becomes a claim to shoppers.
  const n = chQuery<{ units: string }>(
    `SELECT sum(qty) AS units FROM order_lines FINAL
      WHERE product_id = {pid:UInt32} AND city = {city:String} AND source = 'live' AND at > now() - INTERVAL 7 DAY`,
    { pid: productId, city },
  )
    .then((r) => Number(r[0]?.units ?? 0))
    .catch(() => {
      weekCache.delete(key); // don't remember a failure: the next page load asks again
      return null;
    });
  if (weekCache.size > 2000) weekCache.clear();
  weekCache.set(key, { at: Date.now(), n });
  return n;
}

export async function together(ids: number[], city: string, size = 4): Promise<Together> {
  const t0 = performance.now();
  const [pairs, boughtWeek] = await Promise.all([
    coPurchases(ids),
    ids.length === 1 ? boughtThisWeek(ids[0]!, city) : Promise.resolve(null),
  ]);
  const orders = new Map(pairs.map((p) => [p.pid, p.orders]));
  // One shared order is chance; two or more is a pattern.
  const strong = pairs.filter((p) => p.orders >= 2);
  const onShelf = (await productsInCity(strong.map((p) => p.pid), city)).filter((i) => i.inStock);
  const items: Together['items'] = onShelf.slice(0, size).map((i) => ({ ...i, basis: 'orders', orders: orders.get(i.productId) }));
  if (items.length < size) {
    const taken = new Set([...ids, ...items.map((i) => i.productId)]);
    const extra = await goesWith(ids, city, size + ids.length + items.length).catch(() => []);
    for (const i of extra) {
      if (items.length >= size) break;
      if (!taken.has(i.productId)) items.push({ ...i, basis: 'goes-with' });
    }
  }
  return { items, boughtWeek, tookMs: Math.round(performance.now() - t0) };
}
