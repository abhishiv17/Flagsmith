/**
 * Partner retailers (fictional, like the catalogue's brands): two shops per city that stock some of
 * the same products at their own price. Idempotent: re-running resets their offers to these values.
 * Usage: npm run sellers:seed
 */
import 'dotenv/config';
import { closePool, getPool, withTx } from '../server/lib/db.js';

const SELLERS = [
  { slug: 'gadget-gully-blr', name: 'Gadget Gully', city: 'BLR', rating: 4.6, delivery: 'Delivers in Bengaluru by tomorrow' },
  { slug: 'echo-ohm-blr', name: 'Echo & Ohm', city: 'BLR', rating: 4.3, delivery: 'Pickup today in Indiranagar' },
  { slug: 'volt-bazaar-mum', name: 'Volt Bazaar', city: 'MUM', rating: 4.5, delivery: 'Delivers in Mumbai by tomorrow' },
  { slug: 'tune-street-mum', name: 'Tune Street', city: 'MUM', rating: 4.2, delivery: 'Pickup today in Bandra' },
  { slug: 'circuit-corner-del', name: 'Circuit Corner', city: 'DEL', rating: 4.4, delivery: 'Delivers in Delhi by tomorrow' },
  { slug: 'byte-bazaar-del', name: 'Byte Bazaar', city: 'DEL', rating: 4.1, delivery: 'Pickup today in Lajpat Nagar' },
];

/** What partners stock: mostly audio and phone accessories, plus a few everyday items. */
const SKUS = ['AUD-001', 'AUD-002', 'AUD-003', 'AUD-004', 'AUD-006', 'WRB-001', 'WRB-002', 'MOB-001', 'MOB-002', 'MOB-003', 'HOM-001', 'BAG-001'];

// Deterministic per-seller price tweak (−4% … +9%) and stock (2 … 6), so every run gives the same shelf.
const tweak = (i: number, j: number) => [-0.04, 0.03, 0.06, 0.09, -0.02, 0.05][(i + j) % 6]!;
const stock = (i: number, j: number) => 2 + ((i * 3 + j * 5) % 5);
/** Shop-style price: nearest ₹100, minus ₹1 (₹1,338 → ₹1,299), never below ₹99. */
const roundRupee = (paise: number) => Math.max(9_900, Math.round(paise / 10_000) * 10_000 - 100);

async function main() {
  const pool = getPool();
  const { rows: products } = await pool.query<{ id: number; sku: string; price_paise: number }>(
    'SELECT id, sku, price_paise FROM products WHERE sku = ANY($1::text[])', [SKUS],
  );
  await withTx(async (tx) => {
    for (const [i, s] of SELLERS.entries()) {
      const { rows } = await tx.query<{ id: number }>(
        `INSERT INTO sellers (slug, name, city_code, rating, delivery_note) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, city_code = EXCLUDED.city_code,
           rating = EXCLUDED.rating, delivery_note = EXCLUDED.delivery_note
         RETURNING id`,
        [s.slug, s.name, s.city, s.rating, s.delivery],
      );
      const sellerId = rows[0]!.id;
      for (const [j, p] of products.entries()) {
        // Each partner carries most (not all) of the list; Everyday Buds is always carried (demo).
        if (p.sku !== 'AUD-001' && (i + j) % 4 === 3) continue;
        await tx.query(
          `INSERT INTO seller_offers (seller_id, product_id, price_paise, qty) VALUES ($1, $2, $3, $4)
           ON CONFLICT (seller_id, product_id) DO UPDATE SET price_paise = EXCLUDED.price_paise, qty = EXCLUDED.qty, updated_at = now()`,
          [sellerId, p.id, roundRupee(p.price_paise * (1 + tweak(i, j))), stock(i, j)],
        );
      }
    }
  });
  const summary = await pool.query<{ name: string; city_code: string; offers: string; units: string }>(
    `SELECT s.name, s.city_code, count(o.*) AS offers, coalesce(sum(o.qty), 0) AS units
       FROM sellers s LEFT JOIN seller_offers o ON o.seller_id = s.id GROUP BY s.id ORDER BY s.city_code, s.name`,
  );
  console.table(summary.rows);
}

main()
  .catch((e) => {
    console.error('sellers:seed failed:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
