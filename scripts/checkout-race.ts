import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { closePool, getPool, withTx } from '../server/lib/db.js';
import { setStock } from '../server/domain/stock.js';
import { releaseOrder } from '../server/domain/payments.js';

/** Five independent shoppers, one unit. This tests PostgreSQL checkout, not Razorpay payments. */
const sku = 'AUD-001';
const city = 'BLR';
const runId = randomUUID();
const pool = getPool();
const initial = await pool.query<{ product_id: number; qty: number }>(
  `SELECT p.id AS product_id, i.qty FROM products p
   JOIN inventory i ON i.product_id = p.id AND i.city_code = $2 WHERE p.sku = $1`,
  [sku, city],
);
const product = initial.rows[0];
if (!product) throw new Error(`Seeded product ${sku}/${city} not found; run the seed first.`);
const productId = product.product_id;

const server = createApp().listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Cannot determine local port');
const base = `http://127.0.0.1:${address.port}`;

async function shopper(index: number) {
  const session = await fetch(`${base}/api/cart?city=${city}`);
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'shopper must get a distinct session cookie');
  const headers = { 'Content-Type': 'application/json', Cookie: cookie };
  const cart = await fetch(`${base}/api/cart/items`, {
    method: 'POST', headers,
    body: JSON.stringify({ city, productId, qty: 1 }),
  });
  assert.equal(cart.status, 200);
  const key = randomUUID();
  return {
    index,
    key,
    checkout: () => fetch(`${base}/api/checkout`, {
      method: 'POST', headers,
      body: JSON.stringify({
        city,
        customer: { name: `Race Shopper ${index}`, email: `race-${runId}-${index}@example.com` },
        idempotencyKey: key,
      }),
    }),
  };
}

try {
  // Cart claims stop a 2nd shopper *adding* the last unit, so fill the carts while there are 5, then
  // drop to 1: the checkout race still has to give it to exactly one of five full carts.
  await withTx((tx) => setStock(tx, { productId, city, qty: 5, reason: 'restock' }));
  const shoppers = await Promise.all(Array.from({ length: 5 }, (_, index) => shopper(index + 1)));
  await withTx((tx) => setStock(tx, { productId, city, qty: 1, reason: 'restock' }));
  assert.equal(new Set(shoppers.map((s) => s.key)).size, 5);

  const started = performance.now();
  const responses = await Promise.all(shoppers.map((s) => s.checkout()));
  const elapsedMs = Math.round(performance.now() - started);
  const statuses = responses.map((response) => response.status);
  const winners = shoppers.filter((_, index) => statuses[index] === 201);
  assert.equal(winners.length, 1, `expected one winner, got statuses ${statuses}`);
  assert.equal(statuses.filter((status) => status === 409).length, 4, `expected four stockouts, got ${statuses}`);

  const stock = await pool.query<{ qty: number }>(
    'SELECT qty FROM inventory WHERE product_id = $1 AND city_code = $2', [productId, city],
  );
  assert.equal(stock.rows[0]?.qty, 0);
  const orders = await pool.query<{ count: string }>(
    'SELECT count(*) FROM orders WHERE idempotency_key = ANY($1::text[])', [shoppers.map((s) => s.key)],
  );
  assert.equal(Number(orders.rows[0]?.count), 1);

  console.log(JSON.stringify({
    test: 'five independent shoppers, one stock unit',
    winner: winners[0]!.index,
    statuses,
    successfulOrders: 1,
    outOfStock: 4,
    stockAfterRace: 0,
    elapsedMs,
    paymentTested: false,
  }, null, 2));
} finally {
  // With payments on, the winner is a pending hold: release it before resetting stock, or the hold's
  // later expiry would put the unit back on top of the reset.
  const mine = await pool.query<{ id: string }>(
    `SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.status = 'pending_payment' AND c.email LIKE $1`,
    [`race-${runId}-%@example.com`],
  );
  for (const r of mine.rows) await releaseOrder(r.id, 'cancelled');
  await withTx((tx) => setStock(tx, { productId, city, qty: product.qty, reason: 'restock' }));
  await closePool();
  server.close();
}
