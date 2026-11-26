import { getPool } from './db.js';
import { getSearch } from './search.js';
import { productsIndexBody } from './search-schema.js';
import { log, errMsg } from './log.js';

/**
 * Partner shops in OpenSearch. One document per (shop, product) the shop sells: the shop's name,
 * city and rating next to the product's text, price and stock.
 *
 * Search uses it to find shops by name, with typos ("gadget gulli") and as you type ("gadg"), and to
 * search inside one shop. PostgreSQL stays the source of truth for price and stock: every answer
 * that shows a number reads it fresh from seller_offers (a shop has tens of rows, one query), so a
 * sale is never shown late even if this index is a minute behind.
 *
 * Kept in sync from PostgreSQL by syncShopsIndex(): on web start-up and every SHOPS_SYNC_MS after
 * that. Only matching uses the index (names, text); stock and price shown always come from PostgreSQL.
 */

export const SHOPS_INDEX = process.env.OPENSEARCH_SHOPS_INDEX ?? 'shop_offers';
const SHOPS_SYNC_MS = 60_000;

const shopsIndexBody = {
  settings: { number_of_shards: 1, number_of_replicas: 0, analysis: productsIndexBody.settings.analysis },
  mappings: {
    dynamic: 'strict',
    properties: {
      seller_id: { type: 'integer' },
      seller_slug: { type: 'keyword' },
      seller_name: { type: 'text', analyzer: 'product_text', fields: { kw: { type: 'keyword' }, sayt: { type: 'search_as_you_type' } } },
      city: { type: 'keyword' },
      city_name: { type: 'keyword' },
      rating: { type: 'float' },
      product_id: { type: 'integer' },
      sku: { type: 'keyword' },
      name: { type: 'text', analyzer: 'product_text', fields: { kw: { type: 'keyword' }, sayt: { type: 'search_as_you_type' } } },
      brand: { type: 'text', analyzer: 'product_text' },
      category: { type: 'keyword' },
      tags: { type: 'text', analyzer: 'product_text' },
      description: { type: 'text', analyzer: 'product_text' },
      price_paise: { type: 'integer' },
      qty: { type: 'integer' },
      in_stock: { type: 'boolean' },
      updated_at: { type: 'date' },
    },
  },
};

interface OfferRow {
  seller_id: number; slug: string; seller_name: string; city_code: string; city_name: string; rating: string;
  product_id: number; sku: string; name: string; brand: string; category: string; tags: string[]; description: string;
  price_paise: number; qty: number; updated_at: Date;
}

const OFFER_ROWS = `
  SELECT s.id AS seller_id, s.slug, s.name AS seller_name, s.city_code, c.name AS city_name, s.rating,
         p.id AS product_id, p.sku, p.name, p.brand, p.category, p.tags, p.description,
         o.price_paise, o.qty, o.updated_at
    FROM seller_offers o
    JOIN sellers s ON s.id = o.seller_id
    JOIN cities c ON c.code = s.city_code
    JOIN products p ON p.id = o.product_id`;

let ready = false;
let syncing: Promise<number | null> | null = null;
let timer: NodeJS.Timeout | undefined;

/** True once the shops index has been built in this process (search falls back to PostgreSQL until then). */
export const shopsIndexReady = () => ready;

/** Create the index if needed and write every offer from PostgreSQL. Never throws. */
export function syncShopsIndex(): Promise<number | null> {
  syncing ??= (async () => {
    const os = getSearch();
    try {
      const exists = (await os.indices.exists({ index: SHOPS_INDEX })).body;
      if (!exists) await os.indices.create({ index: SHOPS_INDEX, body: shopsIndexBody as never });
      const { rows } = await getPool().query<OfferRow>(OFFER_ROWS);
      for (let i = 0; i < rows.length; i += 500) {
        const body = rows.slice(i, i + 500).flatMap((r) => [
          { index: { _index: SHOPS_INDEX, _id: `${r.seller_id}:${r.product_id}` } },
          {
            seller_id: r.seller_id, seller_slug: r.slug, seller_name: r.seller_name, city: r.city_code, city_name: r.city_name,
            rating: Number(r.rating), product_id: r.product_id, sku: r.sku, name: r.name, brand: r.brand, category: r.category,
            tags: r.tags, description: r.description, price_paise: r.price_paise, qty: r.qty, in_stock: r.qty > 0,
            updated_at: r.updated_at.toISOString(),
          },
        ]);
        const bulk = await os.bulk({ body });
        if ((bulk.body as { errors: boolean }).errors) throw new Error('bulk indexing shop offers failed');
      }
      await os.indices.refresh({ index: SHOPS_INDEX });
      if (!ready) log.info('shops: index in sync', { index: SHOPS_INDEX, offers: rows.length });
      ready = true;
      return rows.length;
    } catch (e) {
      log.warn('shops: index sync failed, shop search uses PostgreSQL', { err: errMsg(e) });
      return null;
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/** Build now, then keep refreshing in the background (web process only). */
export function startShopsIndex(): void {
  void syncShopsIndex();
  timer ??= setInterval(() => void syncShopsIndex(), SHOPS_SYNC_MS);
  timer.unref?.();
}

/* ---------------- reads ---------------- */

export interface ShopSummary {
  id: number; slug: string; name: string; city: string; cityName: string; rating: number; deliveryNote: string;
  products: number; inStock: number; lastUnits: number; minPricePaise: number | null;
}

/** Every partner shop with live counts from PostgreSQL. */
/**
 * Storefronts poll every 4 s per open tab, so shop counts and offer rows are shared for 1.5 s:
 * one PostgreSQL query serves everyone looking at the same shop in that window (and concurrent
 * callers wait on the same promise). Stock stays live to within 1.5 s. Load test: doc/15.
 */
const SHOP_TTL_MS = 1500;
const shared = new Map<string, { at: number; v: Promise<unknown> }>();
function sharedFor<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = shared.get(key);
  if (hit && Date.now() - hit.at < SHOP_TTL_MS) return hit.v as Promise<T>;
  const v = load();
  v.catch(() => shared.delete(key));
  if (shared.size > 500) shared.clear();
  shared.set(key, { at: Date.now(), v });
  return v;
}

/** A shop by its URL slug, or null (from the shared summaries). */
export async function shopBySlug(slug: string): Promise<ShopSummary | null> {
  return (await listShopSummaries()).find((s) => s.slug === slug) ?? null;
}

export async function listShopSummaries(ids?: number[]): Promise<ShopSummary[]> {
  const all = await sharedFor('summaries', loadShopSummaries);
  return ids ? all.filter((s) => ids.includes(s.id)) : all;
}

async function loadShopSummaries(): Promise<ShopSummary[]> {
  const { rows } = await getPool().query<{
    id: number; slug: string; name: string; city_code: string; city_name: string; rating: string; delivery_note: string;
    products: string; in_stock: string; last_units: string; min_price: number | null;
  }>(
    `SELECT s.id, s.slug, s.name, s.city_code, c.name AS city_name, s.rating, s.delivery_note,
            count(o.product_id) AS products, count(*) FILTER (WHERE o.qty > 0) AS in_stock,
            count(*) FILTER (WHERE o.qty BETWEEN 1 AND 2) AS last_units, min(o.price_paise) FILTER (WHERE o.qty > 0) AS min_price
       FROM sellers s JOIN cities c ON c.code = s.city_code
       LEFT JOIN seller_offers o ON o.seller_id = s.id
      GROUP BY s.id, c.name ORDER BY s.city_code, s.name`,
  );
  return rows.map((r) => ({
    id: r.id, slug: r.slug, name: r.name, city: r.city_code, cityName: r.city_name, rating: Number(r.rating),
    deliveryNote: r.delivery_note, products: Number(r.products), inStock: Number(r.in_stock), lastUnits: Number(r.last_units),
    minPricePaise: r.min_price,
  }));
}

/**
 * Shops whose NAME matches the query: as you type ("gadg"), with typos ("gadget gulli"), or a whole
 * word of it ("gully"). OpenSearch when the index is ready, else a PostgreSQL ILIKE.
 */
export async function findShops(q: string, opts: { prefix?: boolean; size?: number; timeoutMs?: number } = {}): Promise<{ id: number; score: number }[]> {
  const text = q.trim();
  if (text.length < 2) return [];
  const size = opts.size ?? 3;
  if (ready) {
    try {
      const should: object[] = [
        { match: { seller_name: { query: text, operator: 'and', fuzziness: 'AUTO', prefix_length: 1, boost: 2 } } },
        { match_phrase: { 'seller_name.kw': { query: text, boost: 5 } } },
      ];
      if (opts.prefix) {
        should.push({
          multi_match: { query: text, type: 'bool_prefix', fields: ['seller_name.sayt', 'seller_name.sayt._2gram', 'seller_name.sayt._3gram'], operator: 'and', boost: 3 },
        });
      }
      const res = await getSearch().search({
        index: SHOPS_INDEX,
        body: {
          size: 0,
          query: { bool: { should, minimum_should_match: 1 } },
          aggs: { shops: { terms: { field: 'seller_id', size, order: { best: 'desc' } }, aggs: { best: { max: { script: { source: '_score' } } } } } },
        } as never,
      }, opts.timeoutMs ? { requestTimeout: opts.timeoutMs, maxRetries: 0 } : undefined);
      const buckets = (res.body as any).aggregations.shops.buckets as { key: number; best: { value: number } }[];
      return buckets.map((b) => ({ id: b.key, score: b.best.value }));
    } catch (e) {
      log.warn('shops: name search failed, using PostgreSQL', { err: errMsg(e) });
    }
  }
  const like = `%${text.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const { rows } = await getPool().query<{ id: number }>('SELECT id FROM sellers WHERE name ILIKE $1 ORDER BY name LIMIT $2', [like, size]);
  return rows.map((r) => ({ id: r.id, score: 1 }));
}

/** Product ids in one shop matching a query, best first (null when the index can't answer). */
async function matchInShop(sellerId: number, q: string): Promise<number[] | null> {
  if (!ready) return null;
  try {
    const res = await getSearch().search({
      index: SHOPS_INDEX,
      body: {
        size: 500,
        _source: ['product_id'],
        query: {
          bool: {
            filter: [{ term: { seller_id: sellerId } }],
            should: [
              { multi_match: { query: q, fields: ['name^3', 'tags^2', 'brand^2', 'description'], analyzer: 'product_text_syn', boost: 2 } },
              { multi_match: { query: q, fields: ['name^3', 'tags^2', 'brand^2', 'description'], fuzziness: 'AUTO', prefix_length: 1 } },
              { multi_match: { query: q, type: 'bool_prefix', fields: ['name.sayt', 'name.sayt._2gram', 'name.sayt._3gram'], boost: 2 } },
            ],
            minimum_should_match: 1,
          },
        },
      } as never,
    });
    return ((res.body as any).hits.hits as { _source: { product_id: number } }[]).map((h) => h._source.product_id);
  } catch (e) {
    log.warn('shops: in-shop search failed, using PostgreSQL', { err: errMsg(e) });
    return null;
  }
}

export interface ShopItem {
  productId: number; sku: string; name: string; brand: string; category: string; imageKey: string;
  pricePaise: number; ourPricePaise: number; qty: number; inStock: boolean; updatedAt: string;
}

export type ShopSort = 'relevance' | 'price_asc' | 'price_desc' | 'stock' | 'name';

/**
 * Everything one shop sells, with live price and stock from PostgreSQL. With q, OpenSearch picks and
 * orders the matches (typos, synonyms, as-you-type); without, in stock first, then by name.
 */
export async function shopCatalogue(sellerId: number, p: { q?: string; category?: string; inStock?: boolean; sort?: ShopSort }) {
  const rows = await sharedFor(`offers:${sellerId}`, () => offerRows(sellerId));
  return filterCatalogue(sellerId, rows, p);
}

async function offerRows(sellerId: number) {
  const { rows } = await getPool().query<{
    product_id: number; sku: string; name: string; brand: string; category: string; image_key: string;
    price_paise: number; our_price: number; qty: number; updated_at: Date;
  }>(
    `SELECT p.id AS product_id, p.sku, p.name, p.brand, p.category, p.image_key, o.price_paise, p.price_paise AS our_price, o.qty, o.updated_at
       FROM seller_offers o JOIN products p ON p.id = o.product_id
      WHERE o.seller_id = $1`,
    [sellerId],
  );
  return rows;
}

async function filterCatalogue(
  sellerId: number,
  rows: Awaited<ReturnType<typeof offerRows>>,
  p: { q?: string; category?: string; inStock?: boolean; sort?: ShopSort },
) {
  let items: ShopItem[] = rows.map((r) => ({
    productId: r.product_id, sku: r.sku, name: r.name, brand: r.brand, category: r.category, imageKey: r.image_key,
    pricePaise: r.price_paise, ourPricePaise: r.our_price, qty: r.qty, inStock: r.qty > 0, updatedAt: r.updated_at.toISOString(),
  }));

  const q = p.q?.trim();
  let rank: Map<number, number> | null = null;
  if (q) {
    const ids = await matchInShop(sellerId, q);
    if (ids) {
      rank = new Map(ids.map((id, i) => [id, i]));
      items = items.filter((i) => rank!.has(i.productId));
    } else {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      items = items.filter((i) => words.every((w) => `${i.name} ${i.brand} ${i.category}`.toLowerCase().includes(w)));
    }
  }

  // Facets before the category / stock filters, so every option keeps its count.
  const categories = [...items.reduce((m, i) => m.set(i.category, (m.get(i.category) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
  if (p.category) items = items.filter((i) => i.category === p.category);
  if (p.inStock) items = items.filter((i) => i.inStock);

  const sort = p.sort ?? 'relevance';
  const byName = (a: ShopItem, b: ShopItem) => a.name.localeCompare(b.name);
  items.sort((a, b) => {
    const stock = Number(b.inStock) - Number(a.inStock);
    switch (sort) {
      case 'price_asc': return stock || a.pricePaise - b.pricePaise;
      case 'price_desc': return stock || b.pricePaise - a.pricePaise;
      case 'stock': return b.qty - a.qty || byName(a, b);
      case 'name': return byName(a, b);
      default: return stock || (rank ? rank.get(a.productId)! - rank.get(b.productId)! : byName(a, b));
    }
  });
  return { items, categories, matchedBy: q ? (rank ? 'opensearch' : 'postgres') : null };
}

/** Per product, the partner shops in this city that have it (for "also at 2 shops from ₹X" on cards). */
export async function partnerSummary(productIds: number[], city: string): Promise<Map<number, { shops: number; minPricePaise: number; topShop: string }>> {
  const out = new Map<number, { shops: number; minPricePaise: number; topShop: string }>();
  if (!productIds.length) return out;
  const { rows } = await getPool().query<{ product_id: number; shops: string; min_price: number; top_shop: string }>(
    `SELECT o.product_id, count(*) AS shops, min(o.price_paise) AS min_price,
            (array_agg(s.name ORDER BY o.price_paise, s.rating DESC))[1] AS top_shop
       FROM seller_offers o JOIN sellers s ON s.id = o.seller_id
      WHERE o.product_id = ANY($1::int[]) AND s.city_code = $2 AND o.qty > 0
      GROUP BY o.product_id`,
    [productIds, city],
  );
  for (const r of rows) out.set(r.product_id, { shops: Number(r.shops), minPricePaise: r.min_price, topShop: r.top_shop });
  return out;
}
