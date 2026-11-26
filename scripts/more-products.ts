/**
 * Adds the MORE_PRODUCTS (server/db/catalogue.ts) to a live database WITHOUT wiping it.
 * Usage: npm run products:more
 *
 * - Inserts each product if its SKU isn't there yet (safe to re-run).
 * - Sets 2 in stock in every city through setStock → outbox → Kafka, so the indexer adds them to
 *   search (keep `npm run workers` running).
 * - Gives every partner retailer 2 of each, at its own price (a little above or below ours),
 *   so a shopper who misses out always has somewhere else to buy.
 */
import 'dotenv/config';
import { closePool, getPool, withTx } from '../server/lib/db.js';
import { setStock } from '../server/domain/stock.js';
import { CITIES, MORE_PRODUCTS, PRODUCTS } from '../server/db/catalogue.js';
import { DETAILS } from '../server/db/catalogue-details.js';
import { FULL } from '../server/db/catalogue-specs.js';

const PARTNER_QTY = 2;
const pool = getPool();

/** Deterministic partner price: ±8% of ours, ending in 99. */
function partnerPrice(ourPaise: number, sellerId: number, productId: number) {
  const pct = (((sellerId * 7 + productId * 13) % 17) - 8) / 100;
  return Math.max(9_900, Math.round((ourPaise * (1 + pct)) / 10_000) * 10_000 - 100);
}

try {
  let added = 0;
  const ids: { id: number; price: number }[] = [];
  for (const p of PRODUCTS.filter((x) => MORE_PRODUCTS.some((m) => m.sku === x.sku))) {
    const ins = await pool.query<{ id: number }>(
      `INSERT INTO products (sku, name, brand, category, description, tags, price_paise, image_key, features, uses, about)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (sku) DO NOTHING RETURNING id`,
      [p.sku, p.name, p.brand, p.category, p.description, p.tags, p.priceInr * 100, p.imageKey,
        p.features ?? [], p.uses ?? [], p.about ?? ''],
    );
    // Only NEW products get stock and shop offers: re-running never resets live stock or shelves.
    if (!ins.rows[0]) continue;
    added++;
    const id = ins.rows[0].id;
    ids.push({ id, price: p.priceInr * 100 });
    for (const c of CITIES) await withTx((tx) => setStock(tx, { productId: id, city: c.code, qty: p.stock[c.code], reason: 'restock' }));
  }

  // doc/19: feature bullets and "good for" tags for EVERY catalogue product (the original 30 too).
  // Run `npm run search:reindex` afterwards so OpenSearch picks them up.
  let detailed = 0;
  for (const p of PRODUCTS) {
    const x = FULL[p.sku];
    const r = await pool.query(
      `UPDATE products SET tags = $13, features = $2, uses = $3, about = $4, specs = $5, in_box = $6, warranty_months = $7,
              colour = $8, connectivity = $9, water_rating = $10, battery_hours = $11, weight_g = $12
        WHERE sku = $1`,
      [p.sku, p.features ?? [], p.uses ?? [], x?.about || p.about || '', JSON.stringify(x?.specs ?? []), x?.box ?? [], x?.warrantyMonths ?? null,
        x?.colour ?? null, x?.connectivity ?? [], x?.waterRating ?? null, x?.batteryHours ?? null, x?.weightG ?? null, p.tags],
    );
    detailed += r.rowCount ?? 0;
  }
  console.log(`Details (highlights, good-for, about, specs, in the box, warranty, attributes) set on ${detailed} products.`);

  const sellers = await pool.query<{ id: number }>('SELECT id FROM sellers');
  for (const s of sellers.rows) {
    for (const p of ids) {
      await pool.query(
        `INSERT INTO seller_offers (seller_id, product_id, price_paise, qty) VALUES ($1, $2, $3, $4)
         ON CONFLICT (seller_id, product_id) DO UPDATE SET qty = EXCLUDED.qty, updated_at = now()`,
        [s.id, p.id, partnerPrice(p.price, s.id, p.id), PARTNER_QTY],
      );
    }
  }

  const total = await pool.query<{ n: string }>('SELECT count(*) AS n FROM products');
  console.log(`${added} new product(s) added, ${MORE_PRODUCTS.length - added} already there. Catalogue now has ${total.rows[0]!.n} products.`);
  console.log(`The ${added} new one(s) are in stock in ${CITIES.map((c) => c.name).join(', ')}.`);
  console.log(sellers.rows.length
    ? `${sellers.rows.length} partner retailers each have ${PARTNER_QTY} of every one.`
    : 'No partner retailers yet: run `npm run sellers:seed`, then this again.');
  console.log('Keep `npm run workers` running so search picks them up.');
} finally {
  await closePool();
}
