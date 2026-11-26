/**
 * Accounts (doc/17) against the real database: npm run accounts:test
 *
 *  1. code → wrong code (counted) → right code → signed in, cookie set, /auth/me
 *  2. a guest cart is adopted by the account on sign-in
 *  3. the same account on a 2nd "laptop" sees the same cart, and can't claim the last unit twice
 *  4. a code can't be reused; 5 wrong tries kill a code; asking again within 30 s is refused
 *  5. coupons need sign-in; signed-in checkout uses the account's email, not the typed one
 *  6. /me/orders lists the order; sign-out ends the session
 *  7. back-in-stock alerts: guests refused, one open alert per product+city, told once when stock > 0
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { closePool, getPool, withTx } from '../server/lib/db.js';
import { setStock } from '../server/domain/stock.js';
import { releaseOrder } from '../server/domain/payments.js';
import { notifyBackInStock } from '../server/domain/alerts.js';

const city = 'BLR';
const run = randomUUID().slice(0, 8);
const email = `acct-${run}@example.com`;
const pool = getPool();
const server = createApp().listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const addr = server.address();
if (!addr || typeof addr === 'string') throw new Error('no port');
const base = `http://127.0.0.1:${addr.port}/api`;

/** A browser: keeps its own cookies. */
function browser() {
  const jar = new Map<string, string>();
  return async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const [k, v] = kv!.split('=');
      if (/Expires=Thu, 01 Jan 1970/i.test(c) || v === '') jar.delete(k!);
      else jar.set(k!, v!);
    }
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any, cookies: jar };
  };
}

const prod = (await pool.query<{ id: number; qty: number }>(
  `SELECT p.id, i.qty FROM products p JOIN inventory i ON i.product_id = p.id AND i.city_code = $1 WHERE p.sku = 'AUD-006'`, [city],
)).rows[0]!;
const report: Record<string, unknown> = {};

try {
  await withTx((tx) => setStock(tx, { productId: prod.id, city, qty: 1, reason: 'restock' }));
  await pool.query(`DELETE FROM cart_items ci USING carts c WHERE c.id = ci.cart_id AND c.status = 'active' AND ci.product_id = $1 AND c.city_code = $2`, [prod.id, city]);

  // 1-2. Laptop A, as a guest, claims the last unit, then signs in.
  const a = browser();
  await a(`/cart?city=${city}`);
  assert.equal((await a('/cart/items', { city, productId: prod.id, qty: 1 })).status, 200, 'guest adds last unit');
  const code1 = await a('/auth/code', { email });
  assert.equal(code1.status, 200);
  assert.match(code1.body.demoCode, /^\d{6}$/, 'demo mode shows the code');
  const wrong = code1.body.demoCode === '000000' ? '111111' : '000000';
  const bad = await a('/auth/verify', { email, code: wrong });
  assert.equal(bad.status, 401);
  assert.match(bad.body.error.message, /4 tries left/);
  const ok = await a('/auth/verify', { email, code: code1.body.demoCode, name: 'Test Shopper' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.cookies.get('sh_auth'), 'auth cookie set');
  assert.equal((await a('/auth/me')).body.account.email, email);
  const cartA = await a(`/cart?city=${city}`);
  assert.equal(cartA.body.items.find((i: any) => i.productId === prod.id)?.qty, 1, 'guest cart adopted by account');
  report.signIn = { wrongCodeTriesLeft: 4, cookie: true, guestCartAdopted: true };

  // 4. The used code can't be reused; asking again within 30 s is refused.
  const b = browser();
  await b(`/cart?city=${city}`);
  assert.equal((await b('/auth/verify', { email, code: code1.body.demoCode })).status, 401, 'used code refused');
  assert.equal((await b('/auth/code', { email })).status, 429, 'second code within 30 s refused');

  // 3. Laptop B signs in to the SAME account (fresh code after the 30 s window).
  await pool.query(`UPDATE sign_in_codes SET created_at = created_at - interval '1 minute' WHERE email = $1`, [email]);
  const code2 = await b('/auth/code', { email });
  assert.equal((await b('/auth/verify', { email, code: code2.body.demoCode })).status, 200);
  const cartB = await b(`/cart?city=${city}`);
  assert.equal(cartB.body.items.find((i: any) => i.productId === prod.id)?.qty, 1, 'same cart on laptop B');
  const twice = await b('/cart/items', { city, productId: prod.id, qty: 1 });
  assert.equal(twice.status, 409, 'cannot claim the last unit twice');
  assert.equal(twice.body.error.details.reason, 'already_yours');
  // A third shopper (guest) is still told someone else has it.
  const c = browser();
  await c(`/cart?city=${city}`);
  assert.equal((await c('/cart/items', { city, productId: prod.id, qty: 1 })).body.error.details.reason, 'in_someone_cart');
  report.twoDevicesOneAccount = { sameCart: true, secondClaim: 'already_yours', otherShopper: 'in_someone_cart' };

  // 4b. Five wrong tries kill a code.
  await pool.query(`UPDATE sign_in_codes SET created_at = created_at - interval '1 minute' WHERE email = $1`, [email]);
  const d = browser();
  await d(`/cart?city=${city}`);
  const code3 = await d('/auth/code', { email });
  const other = code3.body.demoCode === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) await d('/auth/verify', { email, code: other });
  assert.equal((await d('/auth/verify', { email, code: code3.body.demoCode })).status, 401, 'right code refused after 5 wrong tries');
  report.bruteForce = { killedAfter: 5 };

  // 5. Coupons need sign-in; signed-in checkout uses the account email.
  const coupon = await c('/coupons/preview', { city, email, code: 'NOPE-123' });
  assert.equal(coupon.status, 401);
  assert.equal(coupon.body.error.code, 'SIGN_IN_REQUIRED');
  const placed = await a('/checkout', {
    city, customer: { name: 'Test Shopper', email: 'someone-else@example.com' }, idempotencyKey: randomUUID(),
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const owner = await pool.query<{ email: string }>(
    'SELECT c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1', [placed.body.orderId]);
  assert.equal(owner.rows[0]?.email, email, 'order belongs to the verified email, not the typed one');
  if (placed.body.status === 'pending_payment') await releaseOrder(placed.body.orderId, 'cancelled');

  // 7. Back-in-stock alerts.
  assert.equal((await c('/me/alerts', { productId: prod.id, city })).body.error.code, 'SIGN_IN_REQUIRED', 'guests can’t set alerts');
  await a('/me/alerts', { productId: prod.id, city });
  const twiceAlert = await a('/me/alerts', { productId: prod.id, city });
  assert.equal(twiceAlert.status, 201);
  assert.equal(twiceAlert.body.items.filter((x: any) => x.productId === prod.id && !x.notifiedAt).length, 1, 'one open alert');
  const fakeEvent = -Math.floor(Math.random() * 1e9); // not a real outbox id
  assert.equal(await notifyBackInStock(fakeEvent, { productId: prod.id, cityCode: city, qty: 0 }), 0, 'qty 0: nobody told');
  const told = await notifyBackInStock(fakeEvent, { productId: prod.id, cityCode: city, qty: 3 });
  assert.ok(told >= 1, 'waiting shopper told when back');
  assert.equal(await notifyBackInStock(fakeEvent, { productId: prod.id, cityCode: city, qty: 3 }), 0, 'replayed event tells nobody again');
  const after = await a('/me/alerts');
  assert.ok(after.body.items.find((x: any) => x.productId === prod.id)?.notifiedAt, 'alert shows as notified');
  report.backInStock = { guestRefused: true, oneOpenAlert: true, toldOnce: true };

  // 6. My orders, then sign out.
  const mine = await a('/me/orders');
  assert.ok(mine.body.items.some((o: any) => o.orderId === placed.body.orderId), 'order in /me/orders');
  assert.equal((await a('/auth/logout', {})).status, 200);
  assert.equal((await a('/auth/me')).body.account, null, 'signed out');
  assert.equal((await a('/me/orders')).status, 401);
  report.ordersAndSignOut = { typedEmailIgnored: true, inMyOrders: true, signedOut: true };

  console.log(JSON.stringify({ suite: 'accounts', passed: true, ...report }, null, 2));
} finally {
  // Clean up: test carts, sessions, codes; the test order stays (cancelled) like other test orders.
  await pool.query(`DELETE FROM cart_items ci USING carts c WHERE c.id = ci.cart_id AND c.status = 'active' AND ci.product_id = $1 AND c.city_code = $2`, [prod.id, city]);
  await pool.query(`DELETE FROM account_sessions s USING customers c WHERE c.id = s.customer_id AND c.email = $1`, [email]);
  await pool.query('DELETE FROM sign_in_codes WHERE email = $1', [email]);
  await pool.query(`DELETE FROM back_in_stock_alerts a USING customers c WHERE c.id = a.customer_id AND c.email = $1`, [email]);
  await withTx((tx) => setStock(tx, { productId: prod.id, city, qty: prod.qty, reason: 'restock' }));
  server.close();
  await closePool();
}
