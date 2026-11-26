/**
 * Demo stock for the two-laptop demo, in ALL three cities. Usage: npm run demo:setup
 *
 *   8 "last unit" products  = 1 in each of Bengaluru, Mumbai, Delhi
 *       whoever adds one to their cart first claims it; everyone after gets the
 *       "out of stock for you" popup with partner retailers to buy from instead
 *   Pocket Speaker (AUD-002) = 2 in each city: two people pay at the same time and both succeed
 *   Added products alternate between 1 and 2 in each city, giving search plenty of both.
 *   Partner retailers: every partner in every city has 2 of each last-unit product
 *
 * Resets cleanly between rehearsals: releases open payment holds on these products and clears them
 * from shoppers' carts (stale cart claims), then sets stock through setStock → outbox → Kafka, so
 * search and live counts update everywhere.
 */
import 'dotenv/config';
import { closePool, getPool, withTx } from '../server/lib/db.js';
import { setStock } from '../server/domain/stock.js';
import { releaseOrder } from '../server/domain/payments.js';
import { MORE_PRODUCTS } from '../server/db/catalogue.js';

const CITIES = ['BLR', 'MUM', 'DEL'] as const;
const LAST_UNIT = ['AUD-001', 'AUD-003', 'AUD-004', 'AUD-006', 'WRB-001', 'WRB-002', 'MOB-003', 'BAG-001',
  ...MORE_PRODUCTS.filter((_, i) => i % 2 === 0).map((p) => p.sku)];
const TWO_UNITS = ['AUD-002', ...MORE_PRODUCTS.filter((_, i) => i % 2 === 1).map((p) => p.sku)];
const PARTNER_QTY = 2;

const pool = getPool();
try {
  const { rows: products } = await pool.query<{ id: number; sku: string; name: string; price_paise: number }>(
    'SELECT id, sku, name, price_paise FROM products WHERE sku = ANY($1::text[]) ORDER BY sku',
    [[...LAST_UNIT, ...TWO_UNITS]],
  );
  const ids = products.map((p) => p.id);
  if (products.length !== LAST_UNIT.length + TWO_UNITS.length) throw new Error('Some demo products are missing; run npm run products:more (or the seed) first.');

  // 1. Open payment holds on these products (ours or partners'): give the stock back first.
  const holds = await pool.query<{ id: string }>(
    `SELECT DISTINCT o.id FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.status = 'pending_payment' AND oi.product_id = ANY($1::int[])`,
    [ids],
  );
  for (const h of holds.rows) await releaseOrder(h.id, 'cancelled');

  // 2. Stale cart claims: take these products out of every active cart.
  const cleared = await pool.query(
    `DELETE FROM cart_items ci USING carts c
      WHERE c.id = ci.cart_id AND c.status = 'active' AND ci.product_id = ANY($1::int[])`,
    [ids],
  );

  // 3. Our stock.
  const table: Record<string, string | number>[] = [];
  let addedOne = 0;
  let addedTwo = 0;
  for (const p of products) {
    const qty = LAST_UNIT.includes(p.sku) ? 1 : 2;
    const row: Record<string, string | number> = { product: p.name };
    for (const city of CITIES) {
      await withTx((tx) => setStock(tx, { productId: p.id, city, qty, reason: 'restock' }));
      row[city] = qty;
    }
    if (MORE_PRODUCTS.some((m) => m.sku === p.sku)) qty === 1 ? addedOne++ : addedTwo++;
    else table.push(row);
  }

  // 4. Partner retailers: every partner carries every last-unit product (2 each), keeping its own
  //    price where it already has one, otherwise ~5% above ours, ending in 99.
  const lastIds = products.filter((p) => p.sku !== 'AUD-002'); // last-unit products and the 36 added ones
  const partners = await pool.query<{ id: number; name: string; city_code: string }>('SELECT id, name, city_code FROM sellers ORDER BY city_code, name');
  for (const s of partners.rows) {
    for (const p of lastIds) {
      const price = Math.max(9_900, Math.round((p.price_paise * 1.05) / 10_000) * 10_000 - 100);
      await pool.query(
        `INSERT INTO seller_offers (seller_id, product_id, price_paise, qty) VALUES ($1, $2, $3, $4)
         ON CONFLICT (seller_id, product_id) DO UPDATE SET qty = EXCLUDED.qty, updated_at = now()`,
        [s.id, p.id, price, PARTNER_QTY],
      );
    }
  }

  console.log(`Released ${holds.rows.length} open payment hold(s); cleared ${cleared.rowCount ?? 0} cart line(s).`);
  console.log('Our stock, all three cities:');
  console.table(table);
  console.log(`+ ${addedOne} added products at 1 and ${addedTwo} at 2 in every city.`);
  console.log(
    partners.rows.length
      ? `Partner retailers (${partners.rows.map((s) => `${s.name} ${s.city_code}`).join(', ')}) each have ${PARTNER_QTY} of every demo product.`
      : 'No partner retailers found: run `npm run sellers:seed` first.',
  );
  console.log('Demo: both laptops pick the same city and press Add to cart on a last-unit product together.');
} finally {
  await closePool();
}
