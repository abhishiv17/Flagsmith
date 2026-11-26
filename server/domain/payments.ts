import { env } from '../config.js';
import { getPool, withTx } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { EventType, orderNumber } from '../lib/events.js';
import { log, errMsg } from '../lib/log.js';
import { createTestOrder, getTestPayment, publicTestKey, signatureValid } from '../lib/razorpay-test.js';
import { changeStock, enqueue } from './stock.js';
import { visitorId } from './activity.js';
import { releaseCoupon } from './coupons.js';

/**
 * Pay-then-confirm (Razorpay Test Mode).
 *
 *   checkout ──► stock held (same row-locked allocation as before) + order 'pending_payment'
 *            └─► Razorpay order created (outside the transaction: no network call while rows are locked)
 *   paid     ──► signature + Razorpay status checked ──► order 'confirmed' + OrderPlaced event
 *   failed / closed / hold expired ──► stock returned via changeStock(+qty, 'release'), order 'cancelled',
 *                                      cart reopened so the shopper can try again
 *
 * Every state change locks the order row first, so "paid" and "released" can never both win.
 */

export interface PaymentHandle {
  keyId: string;
  gatewayOrderId: string;
  amountPaise: number;
  reservedUntil: string;
}

type OrderRow = {
  id: string; order_no: string; city_code: string; status: string; total_paise: number;
  session_id: string | null; cart_id: string | null; gateway_order_id: string | null;
  gateway_payment_id: string | null; reserved_until: Date | null;
  discount_paise: number; coupon_code: string | null;
};

const SELECT_ORDER = `SELECT id, order_no, city_code, status, total_paise, session_id, cart_id,
                             gateway_order_id, gateway_payment_id, reserved_until, discount_paise, coupon_code
                        FROM orders WHERE id = $1`;

/** Create (or reuse) the Razorpay order for a pending StockHop order. Releases the hold if the gateway fails. */
export async function attachGatewayOrder(orderId: string): Promise<PaymentHandle> {
  const { rows } = await getPool().query<OrderRow>(SELECT_ORDER, [orderId]);
  const o = rows[0];
  if (!o || o.status !== 'pending_payment' || !o.reserved_until) {
    throw new HttpError(409, 'VALIDATION', 'This order is no longer waiting for payment.');
  }
  if (o.gateway_order_id) {
    return { keyId: publicTestKey(), gatewayOrderId: o.gateway_order_id, amountPaise: o.total_paise, reservedUntil: o.reserved_until.toISOString() };
  }
  try {
    const g = await createTestOrder(o.total_paise, orderNumber(o.city_code, o.order_no));
    await getPool().query('UPDATE orders SET gateway_order_id = $2 WHERE id = $1 AND gateway_order_id IS NULL', [orderId, g.id]);
    return { keyId: publicTestKey(), gatewayOrderId: g.id, amountPaise: g.amount, reservedUntil: o.reserved_until.toISOString() };
  } catch (e) {
    await releaseOrder(orderId, 'gateway_error');
    throw e instanceof HttpError ? e : new HttpError(503, 'INTERNAL', 'Payments are unavailable right now. Nothing was charged.');
  }
}

/** Return a pending order's stock to the shelf and cancel it. No-op unless it is still pending. */
export async function releaseOrder(orderId: string, why: 'cancelled' | 'failed' | 'expired' | 'gateway_error'): Promise<boolean> {
  return withTx(async (tx) => {
    const { rows } = await tx.query<OrderRow>(`${SELECT_ORDER} FOR UPDATE`, [orderId]);
    const o = rows[0];
    if (!o || o.status !== 'pending_payment') return false;

    const items = await tx.query<{ product_id: number; qty: number; seller_id: number | null }>(
      'SELECT product_id, qty, seller_id FROM order_items WHERE order_id = $1 ORDER BY product_id', // same lock order as checkout
      [orderId],
    );
    for (const it of items.rows) {
      if (it.seller_id) {
        // Partner retailer's units go back to that partner's offer.
        await tx.query(
          'UPDATE seller_offers SET qty = qty + $3, updated_at = now() WHERE seller_id = $1 AND product_id = $2',
          [it.seller_id, it.product_id, it.qty],
        );
      } else {
        await changeStock(tx, { productId: it.product_id, city: o.city_code, delta: it.qty, reason: 'release', orderId });
      }
    }
    await tx.query(`UPDATE orders SET status = 'cancelled', reserved_until = NULL WHERE id = $1`, [orderId]);
    await releaseCoupon(tx, orderId); // an unpaid order doesn't use up the customer's coupon
    // Give the shopper their cart back, unless they have already started a new one.
    if (o.cart_id) {
      await tx.query(
        `UPDATE carts c SET status = 'active', updated_at = now()
          WHERE c.id = $1 AND c.status = 'checked_out'
            AND NOT EXISTS (SELECT 1 FROM carts o WHERE o.session_id = c.session_id AND o.city_code = c.city_code AND o.status = 'active')`,
        [o.cart_id],
      );
    }
    log.info('payment hold released', { orderId, why, items: items.rows.length });
    return true;
  });
}

/** Release every hold whose time is up. Cheap (partial index); called on checkout and order reads. */
export async function sweepExpiredHolds(): Promise<number> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM orders WHERE status = 'pending_payment' AND reserved_until < now() ORDER BY reserved_until LIMIT 25`,
  );
  let n = 0;
  for (const r of rows) {
    try {
      if (await releaseOrder(r.id, 'expired')) n += 1;
    } catch (e) {
      log.error('hold sweep failed', { orderId: r.id, err: errMsg(e) });
    }
  }
  return n;
}

export interface VerifyInput {
  sessionId: string;
  orderId: string;
  gatewayOrderId: string;
  paymentId: string;
  signature: string;
}

/** Confirm a paid order: signature, Razorpay's own record, then one locked state change + OrderPlaced. */
export async function confirmPayment(input: VerifyInput): Promise<{ orderId: string; status: string }> {
  if (!signatureValid(input.gatewayOrderId, input.paymentId, input.signature)) {
    throw new HttpError(400, 'VALIDATION', 'Payment signature did not match. Nothing was confirmed.');
  }
  const payment = await getTestPayment(input.paymentId);
  if (payment.order_id !== input.gatewayOrderId || !['captured', 'authorized'].includes(payment.status)) {
    throw new HttpError(409, 'VALIDATION', `Payment is ${payment.status}, not completed. Nothing was confirmed.`);
  }

  return withTx(async (tx) => {
    const { rows } = await tx.query<OrderRow>(`${SELECT_ORDER} FOR UPDATE`, [input.orderId]);
    const o = rows[0];
    if (!o || o.session_id !== input.sessionId || o.gateway_order_id !== input.gatewayOrderId) {
      throw new HttpError(404, 'NOT_FOUND', 'Order not found.');
    }
    if (payment.amount !== o.total_paise) {
      throw new HttpError(409, 'VALIDATION', 'Paid amount does not match the order. Nothing was confirmed.');
    }
    if (o.status === 'confirmed') return { orderId: o.id, status: 'confirmed' }; // duplicate callback
    if (o.status !== 'pending_payment') {
      // Paid after the hold was released (very slow payment). Stock is gone back to the shelf, so
      // we must not confirm. In Test Mode nothing real was charged; a live system would refund here.
      throw new HttpError(409, 'VALIDATION', 'Your hold expired before the payment finished, so the order was not placed. In this demo nothing real was charged.');
    }

    await tx.query(
      `UPDATE orders SET status = 'confirmed', gateway_payment_id = $2, reserved_until = NULL WHERE id = $1`,
      [o.id, input.paymentId],
    );
    const items = await tx.query<{ product_id: number; name: string; qty: number; unit_price_paise: number; seller_id: number | null; seller: string | null }>(
      `SELECT oi.product_id, p.name, oi.qty, oi.unit_price_paise, oi.seller_id, s.name AS seller
         FROM order_items oi JOIN products p ON p.id = oi.product_id LEFT JOIN sellers s ON s.id = oi.seller_id
        WHERE oi.order_id = $1`,
      [o.id],
    );
    const customer = await tx.query<{ name: string; email: string }>(
      'SELECT c.name, c.email FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1',
      [o.id],
    );
    // Same OrderPlaced payload as non-payment checkout, so the notifier is unchanged.
    await enqueue(tx, env.TOPIC_ORDERS, o.id, EventType.OrderPlaced, {
      orderId: o.id,
      orderNumber: orderNumber(o.city_code, o.order_no),
      cityCode: o.city_code,
      customer: customer.rows[0] ?? { name: '', email: '' },
      items: items.rows.map((i) => ({
        productId: i.product_id, name: i.name, qty: i.qty, unitPricePaise: i.unit_price_paise,
        ...(i.seller_id ? { seller: i.seller, sellerId: i.seller_id } : {}),
      })),
      totalPaise: o.total_paise,
      discountPaise: o.discount_paise,
      couponCode: o.coupon_code,
      visitor: o.session_id ? visitorId(o.session_id) : '',
    });
    return { orderId: o.id, status: 'confirmed' };
  });
}

/** The shopper closed Checkout or the payment failed: give the stock back now rather than waiting. */
export async function cancelPayment(sessionId: string, orderId: string): Promise<{ released: boolean }> {
  const { rows } = await getPool().query<{ session_id: string | null }>('SELECT session_id FROM orders WHERE id = $1', [orderId]);
  if (!rows[0] || rows[0].session_id !== sessionId) throw new HttpError(404, 'NOT_FOUND', 'Order not found.');
  return { released: await releaseOrder(orderId, 'cancelled') };
}
