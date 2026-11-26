import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../lib/db.js';
import { CityCode, HttpError, parse } from '../lib/http.js';
import { liveStock, liveStockLegacy, searchProducts, similarProducts } from '../lib/search-query.js';
import { availabilityFor } from '../domain/cart.js';
import { shopperKey } from '../domain/accounts.js';
import { USES, type Use } from '../db/catalogue-details.js';
import { findShops, listShopSummaries, partnerSummary, shopBySlug, shopCatalogue, type ShopItem, type ShopSummary } from '../lib/shops-index.js';
import { suggest } from '../lib/suggest.js';
import { together } from '../lib/together.js';
import { notePresence } from '../lib/presence.js';
import { visitorId } from '../domain/activity.js';

export const catalog = Router();

catalog.get('/cities', async (_req, res) => {
  const { rows } = await getPool().query<{ code: string; name: string }>('SELECT code, name FROM cities ORDER BY name');
  res.json(rows);
});

const searchQuery = z.object({
  q: z.string().max(100).optional(),
  city: CityCode,
  category: z.string().max(40).optional(),
  minPrice: z.coerce.number().int().nonnegative().optional(),
  maxPrice: z.coerce.number().int().positive().optional(),
  inStock: z.enum(['true', 'false']).optional(),
  use: z.string().max(20).optional(),
  colour: z.string().max(30).optional(),
  conn: z.string().max(30).optional(),
  water: z.string().max(20).optional(),
  battery: z.coerce.number().int().positive().max(1000).optional(),
  ignore: z.string().max(200).optional(),
  sort: z.enum(['relevance', 'price_asc', 'price_desc', 'stock', 'name']).optional(),
  page: z.coerce.number().int().min(1).max(50).default(1),
  size: z.coerce.number().int().min(1).max(48).default(24),
});

/**
 * Browse (no q) and search, both served by OpenSearch. Each item also says which partner shops in
 * the city have it (PostgreSQL, one query), and a query that names a partner shop ("gadget gully")
 * brings that shop up with its live shelf (shops index).
 */
catalog.get('/search', async (req, res) => {
  const p = parse(searchQuery, req.query);
  const q = p.q?.trim() ?? '';
  const [result, shopHits] = await Promise.all([
    searchProducts({ ...p, inStock: p.inStock === 'true', ignore: p.ignore?.split(',').filter(Boolean) }),
    q.length >= 3 && p.page === 1 ? findShops(q, { size: 2 }).catch(() => []) : Promise.resolve([]),
  ]);
  const partners = await partnerSummary(result.items.map((i) => i.productId), result.city ?? p.city).catch(() => new Map());
  const items = result.items.map((i) => ({ ...i, partners: partners.get(i.productId) ?? null }));

  let shops: (ShopSummary & { items: ShopItem[] })[] = [];
  if (shopHits.length) {
    const summaries = await listShopSummaries(shopHits.map((s) => s.id));
    shops = await Promise.all(summaries.map(async (s) => ({ ...s, items: (await shopCatalogue(s.id, { inStock: true })).items.slice(0, 6) })));
  }
  // The shopper typed a shop's name: that's the answer, not a "no exact match" apology.
  const intent = shops.length && result.intent?.notice?.startsWith('No exact match') ? { ...result.intent, notice: undefined } : result.intent;
  res.json({ ...result, items, intent, shops });
});

/** Search-as-you-type for every search box: completions, products, categories, shops. */
catalog.get('/suggest', async (req, res) => {
  const p = parse(z.object({ q: z.string().max(100).default(''), city: CityCode }), req.query);
  res.set('Cache-Control', 'no-store');
  res.json(await suggest(p.q, p.city));
});

/** Partner shops, with live counts. */
catalog.get('/shops', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ items: await listShopSummaries() });
});

/** One partner shop's storefront: everything it sells, live price and stock, searchable (shops index). */
catalog.get('/shops/:slug', async (req, res) => {
  const { slug } = parse(z.object({ slug: z.string().regex(/^[a-z0-9-]{2,60}$/) }), req.params);
  const p = parse(
    z.object({
      q: z.string().max(100).optional(),
      category: z.string().max(40).optional(),
      inStock: z.enum(['true', 'false']).optional(),
      sort: z.enum(['relevance', 'price_asc', 'price_desc', 'stock', 'name']).optional(),
    }),
    req.query,
  );
  const t0 = performance.now();
  const shop = await shopBySlug(slug);
  if (!shop) throw new HttpError(404, 'NOT_FOUND', 'No shop by that name on StockHop.');
  const cat = await shopCatalogue(shop.id, { ...p, inStock: p.inStock === 'true' });
  res.set('Cache-Control', 'no-store');
  res.json({ shop, ...cat, tookMs: Math.round(performance.now() - t0) });
});

/**
 * Live presence heartbeats (lib/presence.ts): an open product page ("view") and a card the pointer
 * rests on ("hover"). Feeds the retailer dashboard's "Live now" within a couple of seconds.
 */
catalog.post('/presence', async (req, res) => {
  const body: unknown = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  const p = parse(
    z.object({
      city: CityCode,
      beats: z.array(z.object({ productId: z.number().int().positive(), kind: z.enum(['view', 'hover', 'cart']) })).min(1).max(10),
    }),
    body,
  );
  const t0 = performance.now();
  const store = await notePresence(p.city, visitorId(await shopperKey(req)), p.beats);
  res.set('Server-Timing', `presence;desc="${store}";dur=${(performance.now() - t0).toFixed(1)}`);
  res.status(202).json({ ok: true });
});

/**
 * "Frequently bought together" (one id, product page) and "Goes well with your cart" (several ids):
 * ClickHouse co-purchases, on the shelf in this city, topped up with OpenSearch complements.
 */
catalog.get('/together', async (req, res) => {
  const p = parse(
    z.object({ city: CityCode, ids: z.string().regex(/^\d+(,\d+){0,23}$/, 'comma-separated product ids (max 24)'), size: z.coerce.number().int().min(1).max(8).default(4) }),
    req.query,
  );
  const ids = [...new Set(p.ids.split(',').map(Number))];
  const t = await together(ids, p.city, p.size);
  res.set('Cache-Control', 'no-store');
  res.set('Server-Timing', `together;dur=${t.tookMs}`);
  res.json(t);
});

/** "Similar, in stock near you" (doc/19): more_like_this, only what's on the shelf in this city. */
catalog.get('/products/:id/similar', async (req, res) => {
  const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
  const { city } = parse(z.object({ city: CityCode }), req.query);
  res.set('Cache-Control', 'no-store');
  res.json({ items: await similarProducts(id, city) });
});

/** Live stock for visible cards, read from the index the Kafka pipeline keeps fresh (ADR-6). */
catalog.get('/stock', async (req, res) => {
  const p = parse(
    z.object({
      city: CityCode,
      ids: z.string().regex(/^\d+(,\d+){0,47}$/, 'comma-separated product ids (max 48)'),
    }),
    req.query,
  );
  res.set('Cache-Control', 'no-store');
  const t0 = performance.now();
  // ?cache=off runs the original OpenSearch-only path: a read-only benchmark switch for the A/B in doc/15.
  const ids = p.ids.split(',').map(Number);
  const { source, items } = req.query.cache === 'off' ? await liveStockLegacy(p.city, ids) : await liveStock(p.city, ids);
  // Which store answered and how long it took: visible in devtools and in the demo.
  res.set('X-Stock-Source', source);
  res.set('Server-Timing', `stock;desc="${source}";dur=${(performance.now() - t0).toFixed(1)}`);
  res.json({ items, source });
});

/**
 * Recent real stock movements (sales and restocks) for the storefront's "happening now" strip.
 * Read from the outbox, and only rows the relay has already published to Kafka.
 */
catalog.get('/activity', async (_req, res) => {
  const { rows } = await getPool().query<{
    id: string;
    payload: { productId: number; cityCode: string; qty: number; delta: number; reason: string; doc: { name: string; sku: string; imageKey: string; cityName: string } };
    created_at: Date;
  }>(
    `SELECT id, payload, created_at FROM outbox
      WHERE event_type = 'InventoryChanged' AND published_at IS NOT NULL
        AND payload->>'reason' IN ('order', 'restock', 'release')
      ORDER BY id DESC LIMIT 12`,
  );
  res.set('Cache-Control', 'no-store');
  res.json({
    items: rows.map(({ id, payload: p, created_at }) => ({
      id: Number(id), productId: p.productId, name: p.doc.name, sku: p.doc.sku, imageKey: p.doc.imageKey,
      city: p.cityCode, cityName: p.doc.cityName, qty: p.qty, delta: p.delta, reason: p.reason, at: created_at,
    })),
  });
});

/** Product detail from PostgreSQL: authoritative price and stock in every city. */
catalog.get('/products/:id', async (req, res) => {
  const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
  const p = await getPool().query<{
    id: number; sku: string; name: string; brand: string; category: string; description: string;
    tags: string[]; price_paise: number; image_key: string; features: string[]; uses: string[];
    about: string; specs: { group: string; label: string; value: string }[]; in_box: string[]; warranty_months: number | null;
    colour: string | null; connectivity: string[]; water_rating: string | null; battery_hours: number | null; weight_g: number | null;
  }>(`SELECT id, sku, name, brand, category, description, tags, price_paise, image_key, features, uses,
             about, specs, in_box, warranty_months, colour, connectivity, water_rating, battery_hours, weight_g
        FROM products WHERE id = $1`, [id]);
  const prod = p.rows[0];
  if (!prod) throw new HttpError(404, 'NOT_FOUND', 'Product not found');

  const stock = await getPool().query<{ city_code: string; name: string; qty: number; version: string }>(
    `SELECT i.city_code, c.name, i.qty, i.version
       FROM inventory i JOIN cities c ON c.code = i.city_code
      WHERE i.product_id = $1 ORDER BY c.name`,
    [id],
  );
  // With ?city=, also say what's available *to this shopper* (others' cart claims taken out), so
  // the page can warn before they add instead of after.
  const cityQ = CityCode.safeParse(req.query.city);
  const forYou = cityQ.success ? await availabilityFor(await shopperKey(req), cityQ.data, id) : null;
  res.set('Cache-Control', 'no-store');
  res.json({
    productId: prod.id, sku: prod.sku, name: prod.name, brand: prod.brand, category: prod.category,
    description: prod.description, tags: prod.tags, pricePaise: prod.price_paise, imageKey: prod.image_key,
    features: prod.features, uses: prod.uses.map((u) => ({ key: u, label: USES[u as Use] ?? u })),
    // doc/19: the product page, marketplace-style
    about: prod.about, specs: prod.specs, inBox: prod.in_box, warrantyMonths: prod.warranty_months,
    attrs: { colour: prod.colour, connectivity: prod.connectivity, waterRating: prod.water_rating, batteryHours: prod.battery_hours, weightG: prod.weight_g },
    stock: stock.rows.map((s) => ({ city: s.city_code, cityName: s.name, qty: s.qty, version: Number(s.version) })),
    ...(forYou ? { forYou } : {}),
  });
});
