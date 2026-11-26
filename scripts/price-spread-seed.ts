/**
 * Partner prices across cities (doc/16): every partner shop gets an offer for EVERY catalogue product,
 * priced for its city, so the same product has a visible price range across Bengaluru, Mumbai and Delhi.
 *
 * Fictional data, like the partner shops themselves. Deterministic (same numbers every run).
 * Existing offers keep their stock count (only the price is reset); new offers get 1–6 units.
 * Our own store's price (products.price_paise) is not touched: one chain-wide price.
 *
 * Usage: npm run prices:seed
 */
import 'dotenv/config';
import { closePool, getPool, withTx } from '../server/lib/db.js';

/** City price level: Mumbai rents push prices up, Delhi's wholesale markets pull them down. */
const CITY_LEVEL: Record<string, number> = { BLR: 0.0, MUM: 0.06, DEL: -0.04 };

/** Small deterministic hash → [0, 1). */
const unit = (...xs: number[]) => {
  let h = 2166136261;
  for (const x of xs) h = Math.imul(h ^ x, 16777619) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  return (h % 10_000) / 10_000;
};
const cityNum = (c: string) => c.charCodeAt(0) * 31 + c.charCodeAt(1);

/** Shop-style price: nearest ₹10, minus ₹1 (₹1,338 → ₹1,339; ₹2,000 → ₹1,999), never below ₹99. */
const shopPrice = (paise: number) => Math.max(9_900, Math.round(paise / 1_000) * 1_000 - 100);

async function main() {
  const pool = getPool();
  const { rows: products } = await pool.query<{ id: number; price_paise: number }>('SELECT id, price_paise FROM products ORDER BY id');
  const { rows: sellers } = await pool.query<{ id: number; city_code: string }>('SELECT id, city_code FROM sellers ORDER BY id');
  let added = 0;
  let repriced = 0;
  await withTx(async (tx) => {
    for (const s of sellers) {
      for (const p of products) {
        // City level + this product's own swing in that city (±7%) + this shop's markup (−3% … +5%).
        const swing = (unit(p.id, cityNum(s.city_code)) - 0.5) * 0.14;
        const markup = unit(s.id, p.id, 7) * 0.08 - 0.03;
        const price = shopPrice(p.price_paise * (1 + (CITY_LEVEL[s.city_code] ?? 0) + swing + markup));
        const qty = 1 + Math.floor(unit(s.id, p.id, 11) * 6);
        const r = await tx.query<{ inserted: boolean }>(
          `INSERT INTO seller_offers (seller_id, product_id, price_paise, qty) VALUES ($1, $2, $3, $4)
           ON CONFLICT (seller_id, product_id) DO UPDATE SET price_paise = EXCLUDED.price_paise, updated_at = now()
           RETURNING (xmax = 0) AS inserted`,
          [s.id, p.id, price, qty],
        );
        if (r.rows[0]?.inserted) added++;
        else repriced++;
      }
    }
  });
  console.log(`partner offers: ${added} added, ${repriced} repriced (${sellers.length} shops × ${products.length} products)`);
  const spread = await pool.query(
    `SELECT p.name, p.price_paise / 100 AS ours,
            min(o.price_paise) / 100 AS lowest, max(o.price_paise) / 100 AS highest,
            string_agg(DISTINCT s.city_code, ',') AS cities
       FROM products p JOIN seller_offers o ON o.product_id = p.id JOIN sellers s ON s.id = o.seller_id
      GROUP BY p.id ORDER BY (max(o.price_paise) - min(o.price_paise))::float / p.price_paise DESC LIMIT 8`,
  );
  console.table(spread.rows);
}

main()
  .catch((e) => {
    console.error('prices:seed failed:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
