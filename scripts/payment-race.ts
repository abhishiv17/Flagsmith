/**
 * Payment concurrency suite (Razorpay Test Mode + PostgreSQL). Usage: npm run payment:race
 *
 * Runs the real API on a local port against the real database and Razorpay Test Mode:
 *   A. 5 shoppers press Pay at once on the LAST unit → exactly 1 hold (with a Razorpay order), 4 told
 *      it was taken; stock 0; no double hold.
 *   B. Forged payment proof is rejected; another shopper can't confirm or cancel someone else's order.
 *   C. The holder cancels → the unit is back (1) and a waiting shopper can now reserve it.
 *   D. 2 units, 2 shoppers paying at the same time → both get holds; stock 0.
 *   E. Cancel and hold-expiry racing on the same order → released exactly once (no extra stock).
 *
 * A real "Success" payment needs a human in Razorpay's window, so the success path is checked in the
 * browser (see doc/13). Everything is cleaned up: holds released, stock restored.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { closePool, getPool, withTx } from '../server/lib/db.js';
import { setStock } from '../server/domain/stock.js';
import { releaseOrder, sweepExpiredHolds } from '../server/domain/payments.js';
import { paymentsEnabled } from '../server/lib/razorpay-test.js';

if (!paymentsEnabled()) throw new Error('Razorpay Test Mode keys are not configured (test_api_key / test_key_secret).');

const city = 'BLR';
const runId = randomUUID().slice(0, 8);
const pool = getPool();

const productId = async (sku: string) => {
  const r = await pool.query<{ id: number; qty: number }>(
    'SELECT p.id, i.qty FROM products p JOIN inventory i ON i.product_id = p.id AND i.city_code = $2 WHERE p.sku = $1', [sku, city],
  );
  if (!r.rows[0]) throw new Error(`${sku} missing; run the seed first.`);
  return r.rows[0];
};
const qtyOf = async (id: number) =>
  (await pool.query<{ qty: number }>('SELECT qty FROM inventory WHERE product_id = $1 AND city_code = $2', [id, city])).rows[0]!.qty;

const server = createApp().listen(0, '127.0.0.1');
await new Promise<void>((r) => server.once('listening', r));
const addr = server.address();
if (!addr || typeof addr === 'string') throw new Error('no port');
const base = `http://127.0.0.1:${addr.port}`;

type Res = { status: number; body: Record<string, unknown> };
async function shopper(label: string, pid: number, addNow = true) {
  const first = await fetch(`${base}/api/cart?city=${city}`);
  const cookie = first.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'each shopper gets its own session');
  const call = async (path: string, body?: unknown): Promise<Res> => {
    const r = await fetch(`${base}/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  if (addNow) assert.equal((await call('/cart/items', { city, productId: pid, qty: 1 })).status, 200);
  return {
    label,
    call,
    add: () => call('/cart/items', { city, productId: pid, qty: 1 }),
    remove: () => fetch(`${base}/api/cart/items/${pid}?city=${city}`, { method: 'DELETE', headers: { Cookie: cookie } }),
    pay: () => call('/checkout', {
      city, idempotencyKey: randomUUID(),
      customer: { name: `Pay Race ${label}`, email: `payrace-${runId}-${label}@example.com` },
    }),
  };
}

const buds = await productId('AUD-001');
const speaker = await productId('AUD-002');

/** Remove the test products from every active cart in the test city (cart claims). */
const clearClaims = () =>
  pool.query(
    `DELETE FROM cart_items ci USING carts c WHERE c.id = ci.cart_id AND c.status = 'active'
        AND c.city_code = $1 AND ci.product_id = ANY($2::int[])`,
    [city, [buds.id, speaker.id]],
  );
const report: Record<string, unknown> = {};

try {
  // Start clean: no leftover cart claims on the test products (e.g. from an interrupted run).
  await clearClaims();

  // ---------- A0. five press "Add to cart" at once on the last unit ----------
  await withTx((tx) => setStock(tx, { productId: buds.id, city, qty: 1, reason: 'restock' }));
  const adders = await Promise.all(['z1', 'z2', 'z3', 'z4', 'z5'].map((l) => shopper(l, buds.id, false)));
  const resAdd = await Promise.all(adders.map((s) => s.add()));
  const addStatuses = resAdd.map((r) => r.status);
  assert.equal(addStatuses.filter((s) => s === 200).length, 1, `exactly one cart should get the last unit, got ${addStatuses}`);
  assert.equal(addStatuses.filter((s) => s === 409).length, 4, `four told straight away, got ${addStatuses}`);
  const refused = resAdd.find((r) => r.status === 409)!.body as { error: { details: { reason: string } } };
  assert.equal(refused.error.details.reason, 'in_someone_cart');
  const claimer = adders[addStatuses.indexOf(200)]!;
  const loser = adders[addStatuses.indexOf(409)]!;
  const seenBefore = (await loser.call(`/products/${buds.id}?city=${city}`)).body.forYou as { availableToYou: number; reason: string };
  assert.equal(seenBefore.availableToYou, 0, 'product page tells the others before they try');
  assert.equal(seenBefore.reason, 'in_someone_cart');
  assert.ok(((await loser.call(`/offers?productId=${buds.id}&city=${city}`)).body.items as unknown[]).length > 0, 'and offers partners');
  // The claimer changes their mind: the unit is free again for the next person.
  assert.equal((await claimer.remove()).status, 200);
  const nextTry = await loser.add();
  assert.equal(nextTry.status, 200, 'after the claimer removes it, the next shopper can add it');
  report.A0_addToCartRace_lastUnit = {
    addStatuses, refusedReason: 'in_someone_cart', othersSeeAvailable: 0, partnerOffersShown: true, afterClaimerRemoves: nextTry.status,
  };
  await pool.query(
    `DELETE FROM cart_items ci USING carts c WHERE c.id = ci.cart_id AND c.status = 'active' AND ci.product_id = $1 AND c.city_code = $2`,
    [buds.id, city],
  );

  // ---------- A. five at checkout, one unit (carts filled while there were 5, then stock drops to 1) ----------
  await withTx((tx) => setStock(tx, { productId: buds.id, city, qty: 5, reason: 'restock' }));
  const five = await Promise.all(['a1', 'a2', 'a3', 'a4', 'a5'].map((l) => shopper(l, buds.id)));
  await withTx((tx) => setStock(tx, { productId: buds.id, city, qty: 1, reason: 'restock' }));
  const t0 = performance.now();
  const resA = await Promise.all(five.map((s) => s.pay()));
  const msA = Math.round(performance.now() - t0);
  const statusesA = resA.map((r) => r.status);
  const winIdx = statusesA.findIndex((s) => s === 201);
  assert.equal(statusesA.filter((s) => s === 201).length, 1, `one hold expected, got ${statusesA}`);
  assert.equal(statusesA.filter((s) => s === 409).length, 4, `four "taken" expected, got ${statusesA}`);
  const winner = five[winIdx]!;
  const hold = resA[winIdx]!.body as { orderId: string; status: string; payment: { gatewayOrderId: string; keyId: string } };
  assert.equal(hold.status, 'pending_payment');
  assert.match(hold.payment.gatewayOrderId, /^order_/);
  assert.match(hold.payment.keyId, /^rzp_test_/);
  assert.equal(await qtyOf(buds.id), 0);
  report.A_lastUnit_fiveShoppers = { statuses: statusesA, holder: winner.label, stockAfter: 0, ms: msA };

  // ---------- A2. the 4 who lost are offered the same item from partner retailers ----------
  const losers = five.filter((_, i) => i !== winIdx);
  const offerLists = await Promise.all(losers.map((s) => s.call(`/offers?productId=${buds.id}&city=${city}`)));
  const offersSeen = offerLists.map((r) => (r.body.items as unknown[]).length);
  assert.ok(offersSeen.every((n) => n > 0), `every loser must see partner offers, got ${offersSeen}`);
  // All four rush the cheapest partner, which has exactly 2 left: 2 win, 2 are told, never oversold.
  const cheapest = (offerLists[0]!.body.items as { sellerId: number; sellerName: string; qty: number }[])[0]!;
  const partnerBefore = (await pool.query<{ qty: number }>('SELECT qty FROM seller_offers WHERE seller_id = $1 AND product_id = $2', [cheapest.sellerId, buds.id])).rows[0]!.qty;
  await pool.query('UPDATE seller_offers SET qty = 2 WHERE seller_id = $1 AND product_id = $2', [cheapest.sellerId, buds.id]);
  const resF = await Promise.all(losers.map((s) => s.call('/checkout/offer', {
    city, idempotencyKey: randomUUID(), sellerId: cheapest.sellerId, productId: buds.id, qty: 1,
    customer: { name: `Pay Race ${s.label}`, email: `payrace-${runId}-${s.label}@example.com` },
  })));
  const statusesF = resF.map((r) => r.status);
  assert.equal(statusesF.filter((s) => s === 201).length, 2, `2 partner holds expected, got ${statusesF}`);
  assert.equal(statusesF.filter((s) => s === 409).length, 2, `2 told the partner sold out, got ${statusesF}`);
  const partnerAfter = (await pool.query<{ qty: number }>('SELECT qty FROM seller_offers WHERE seller_id = $1 AND product_id = $2', [cheapest.sellerId, buds.id])).rows[0]!.qty;
  assert.equal(partnerAfter, 0, 'partner stock never goes below zero');
  // Release the partner holds and check the units go back to the partner, not to our shelf.
  for (const [i, r] of resF.entries()) if (r.status === 201) await losers[i]!.call('/payments/cancel', { orderId: r.body.orderId });
  const partnerReleased = (await pool.query<{ qty: number }>('SELECT qty FROM seller_offers WHERE seller_id = $1 AND product_id = $2', [cheapest.sellerId, buds.id])).rows[0]!.qty;
  assert.equal(partnerReleased, 2, 'cancelled partner holds return to the partner');
  assert.equal(await qtyOf(buds.id), 0, 'our shelf is untouched by partner releases');
  await pool.query('UPDATE seller_offers SET qty = $3 WHERE seller_id = $1 AND product_id = $2', [cheapest.sellerId, buds.id, partnerBefore]);
  report.A2_losersGetPartnerOffers = {
    offersShownToEachLoser: offersSeen,
    partner: cheapest.sellerName,
    fourRushPartnerWith2Left: statusesF,
    partnerStockAfter: partnerAfter,
    afterCancelBackToPartner: partnerReleased,
  };

  // ---------- B. forged proof / someone else's order ----------
  const forged = await winner.call('/payments/verify', {
    orderId: hold.orderId, gatewayOrderId: hold.payment.gatewayOrderId, paymentId: 'pay_FAKE123456789', signature: 'a'.repeat(64),
  });
  assert.equal(forged.status, 400, 'forged signature must be rejected');
  const other = five[(winIdx + 1) % 5]!;
  const stranger = await other.call('/payments/cancel', { orderId: hold.orderId });
  assert.equal(stranger.status, 404, "a shopper can't cancel someone else's order");
  const stillPending = await pool.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [hold.orderId]);
  assert.equal(stillPending.rows[0]!.status, 'pending_payment');
  report.B_forgedAndForeign = { forgedVerify: forged.status, foreignCancel: stranger.status, orderStill: 'pending_payment' };

  // ---------- C. holder cancels → unit returns → waiting shopper gets it ----------
  const cancel = await winner.call('/payments/cancel', { orderId: hold.orderId });
  assert.equal(cancel.status, 200);
  assert.equal(await qtyOf(buds.id), 1, 'cancel returns the unit');
  const retry = await other.pay();
  assert.equal(retry.status, 201, 'the waiting shopper can now reserve it');
  assert.equal(await qtyOf(buds.id), 0);
  const retryHold = retry.body as { orderId: string };
  await other.call('/payments/cancel', { orderId: retryHold.orderId });
  report.C_cancelThenRebuy = { afterCancel: 1, otherShopperRetry: retry.status, afterTheirCancel: await qtyOf(buds.id) };

  // ---------- D. two units, two simultaneous payments ----------
  await withTx((tx) => setStock(tx, { productId: speaker.id, city, qty: 2, reason: 'restock' }));
  const two = await Promise.all(['d1', 'd2'].map((l) => shopper(l, speaker.id)));
  const resD = await Promise.all(two.map((s) => s.pay()));
  assert.deepEqual(resD.map((r) => r.status), [201, 201], 'both should get a hold');
  const gwD = resD.map((r) => (r.body as { payment: { gatewayOrderId: string } }).payment.gatewayOrderId);
  assert.notEqual(gwD[0], gwD[1], 'each gets its own Razorpay order');
  assert.equal(await qtyOf(speaker.id), 0);
  report.D_twoUnits_twoPayments = { statuses: resD.map((r) => r.status), distinctGatewayOrders: true, stockAfter: 0 };

  // ---------- E. cancel vs expiry sweep on the same hold ----------
  const dHold = (resD[0]!.body as { orderId: string }).orderId;
  await pool.query(`UPDATE orders SET reserved_until = now() - interval '1 second' WHERE id = $1`, [dHold]);
  const [, , sweptBy] = await Promise.all([
    two[0]!.call('/payments/cancel', { orderId: dHold }),
    releaseOrder(dHold, 'expired'),
    sweepExpiredHolds(),
  ]);
  void sweptBy;
  assert.equal(await qtyOf(speaker.id), 1, 'released exactly once: one unit back, not two or three');
  const eStatus = (await pool.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [dHold])).rows[0]!.status;
  assert.equal(eStatus, 'cancelled');
  await two[1]!.call('/payments/cancel', { orderId: (resD[1]!.body as { orderId: string }).orderId });
  report.E_cancelVsExpiry = { speakerStockAfter: 1, then: await qtyOf(speaker.id), orderStatus: eStatus };

  console.log(JSON.stringify({ suite: 'payment concurrency (Razorpay Test Mode)', passed: true, ...report }, null, 2));
} finally {
  // Clean up: release anything this run still holds, then restore the original stock.
  const mine = await pool.query<{ id: string }>(
    `SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.status = 'pending_payment' AND c.email LIKE $1`,
    [`payrace-${runId}-%@example.com`],
  );
  for (const r of mine.rows) await releaseOrder(r.id, 'cancelled');
  await clearClaims();
  await withTx((tx) => setStock(tx, { productId: buds.id, city, qty: buds.qty, reason: 'restock' }));
  await withTx((tx) => setStock(tx, { productId: speaker.id, city, qty: speaker.qty, reason: 'restock' }));
  server.close();
  await closePool();
}
