/**
 * Resets demo data and seeds 30 products × 3 cities THROUGH the outbox (doc/02 G6/G7),
 * so the search index is built by the real pipeline (relay → Kafka → indexer).
 *
 * Usage: npm run db:seed
 * Run `npm run search:init -- --recreate` first when resetting a used environment.
 *
 * Note: inventory_version_seq and outbox ids are NOT reset, so old Kafka events can never
 * overwrite newer state during a replay (I-4).
 */
import { withTx, closePool } from '../server/lib/db.js';
import { setStock } from '../server/domain/stock.js';
import { CITIES, PRODUCTS } from '../server/db/catalogue.js';

async function main() {
  // The database is SHARED by the whole team: wiping it must be deliberate.
  if (!process.argv.includes('--yes')) {
    console.error('Refusing to run: this WIPES all orders, carts and stock in the shared database.');
    console.error('Re-run with:  npm run db:seed -- --yes   (or npm run demo:reset)');
    process.exitCode = 1;
    return;
  }
  const seeded = await withTx(async (tx) => {
    await tx.query(`TRUNCATE notifications, stock_alerts, order_items, orders, customers,
                             cart_items, carts, inventory, products, cities
                    RESTART IDENTITY CASCADE`);
    // Outbox is cleared WITHOUT restarting its id sequence (event ids stay unique forever).
    await tx.query('TRUNCATE outbox');
    // Order numbers read like SH-BLR-1001 rather than SH-BLR-1.
    await tx.query(`SELECT setval(pg_get_serial_sequence('orders', 'order_no'), 1000)`);

    for (const c of CITIES) {
      await tx.query('INSERT INTO cities (code, name) VALUES ($1, $2)', [c.code, c.name]);
    }

    let events = 0;
    for (const p of PRODUCTS) {
      const { rows } = await tx.query<{ id: number }>(
        `INSERT INTO products (sku, name, brand, category, description, tags, price_paise, image_key, features, uses, about)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [p.sku, p.name, p.brand, p.category, p.description, p.tags, p.priceInr * 100, p.imageKey, p.features ?? [], p.uses ?? [], p.about ?? ''],
      );
      const productId = rows[0]!.id;
      for (const c of CITIES) {
        await setStock(tx, { productId, city: c.code, qty: p.stock[c.code], reason: 'seed' });
        events++;
      }
    }
    return events;
  });

  console.log(`Seeded ${PRODUCTS.length} products × ${CITIES.length} cities; ${seeded} InventoryChanged events in the outbox.`);
  console.log('Start the workers (npm run workers) to publish them and build the search index.');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closePool);
