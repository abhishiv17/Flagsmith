import { randomUUID } from 'node:crypto';
import { env } from '../config.js';
import { getPool, withTx, type Tx } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { EventType, orderNumber } from '../lib/events.js';
import { changeStock, OUTBOX_CHANNEL } from './stock.js';
import { visitorId } from './activity.js';
import { lockCoupon } from './coupons.js';

/**
 * Checkout: the most important code in the repo (doc/03 §4.1).
 * One READ COMMITTED transaction: lock cart → decrement each item (sorted by product_id to avoid
 * deadlocks) → customer → order → items → outbox (InventoryChanged × n, then OrderPlaced) → close cart.
 * All-or-nothing: any short item rolls everything back and returns 409 naming each one (G8).
 *
 * Lock-hold budget (doc/12 F4): inventory row locks are held from the first decrement until COMMIT,
 * blocking every other buyer of those items. So that window is exactly one round trip per item
 * (changeStock is a single statement) plus ONE statement that writes customer, order, lines,
 * OrderPlaced and closes the cart, plus COMMIT.
 */

export interface CheckoutInput {
  sessionId: string;
  city: string;
  customer: { name: string; email: string; phone?: string };
  idempotencyKey: string;
  /**
   * Payment mode (Razorpay configured): the stock is still allocated here, under the same row
   * locks, but the order is saved as 'pending_payment' with a hold time and no OrderPlaced event.
   * payments.ts confirms it after a verified payment, or releases the stock.
   */
  withPayment?: boolean;
  /** Loyalty coupon from the retailer dashboard (doc/16): checked against this customer's email. */
  couponCode?: string;
}

export interface CheckoutResult {
  orderId: string;
  orderNumber: string;
  totalPaise: number;
  discountPaise?: number;
  status: string;
  replayed: boolean;
}

const UNIQUE_VIOLATION = '23505';

export async function findByKey(key: string, db: Pick<Tx, 'query'> = getPool()): Promise<CheckoutResult | null> {
  const { rows } = await db.query<{ id: string; order_no: string; city_code: string; total_paise: number; status: string }>(
    'SELECT id, order_no, city_code, total_paise, status FROM orders WHERE idempotency_key = $1',
    [key],
  );
  const o = rows[0];
  return o
    ? { orderId: o.id, orderNumber: orderNumber(o.city_code, o.order_no), totalPaise: o.total_paise, status: o.status, replayed: true }
    : null;
}

export async function checkout(input: CheckoutInput): Promise<CheckoutResult> {
  const existing = await findByKey(input.idempotencyKey);
  if (existing) return existing; // G12: a retried/double-clicked submit returns the same order

  try {
    return await withTx(async (tx) => {
      const cart = await tx.query<{ id: string }>(
        `SELECT id FROM carts WHERE session_id = $1 AND city_code = $2 AND status = 'active' FOR UPDATE`,
        [input.sessionId, input.city],
      );
      const cartId = cart.rows[0]?.id;
      if (!cartId) {
        // doc/12 F2: a concurrent duplicate of THIS submit (same key) may have just checked the cart out.
        // We waited on its cart lock; under READ COMMITTED this new statement sees its committed order,
        // so answer with that order instead of a misleading "cart is empty".
        const replay = await findByKey(input.idempotencyKey, tx);
        if (replay) return replay;
        throw new HttpError(409, 'CART_EMPTY', 'Your cart is empty.');
      }

      const { rows: items } = await tx.query<{ product_id: number; qty: number; name: string; price_paise: number }>(
        `SELECT ci.product_id, ci.qty, p.name, p.price_paise
           FROM cart_items ci JOIN products p ON p.id = ci.product_id
          WHERE ci.cart_id = $1
          ORDER BY ci.product_id`,
        [cartId],
      );
      if (items.length === 0) throw new HttpError(409, 'CART_EMPTY', 'Your cart is empty.');

      // Coupon first, BEFORE any inventory row is locked, so it never lengthens the hot-row window.
      // lockCoupon takes the coupon's row lock: two tabs spending one code serialise here.
      const subtotalPaise = items.reduce((sum, it) => sum + it.qty * it.price_paise, 0);
      const coupon = input.couponCode ? await lockCoupon(tx, input.couponCode, input.customer.email, subtotalPaise) : null;

      // ── inventory row locks are held from here until COMMIT ──
      const orderId = randomUUID();
      const short: { productId: number; name: string; requested: number; available: number }[] = [];
      for (const it of items) {
        const res = await changeStock(tx, { productId: it.product_id, city: input.city, delta: -it.qty, reason: 'order', orderId });
        if (!res) short.push({ productId: it.product_id, name: it.name, requested: it.qty, available: 0 });
      }
      if (short.length) {
        const { rows } = await tx.query<{ product_id: number; qty: number }>(
          'SELECT product_id, qty FROM inventory WHERE city_code = $1 AND product_id = ANY($2::int[])',
          [input.city, short.map((s) => s.productId)],
        );
        for (const s of short) s.available = rows.find((r) => r.product_id === s.productId)?.qty ?? 0;
        const first = short[0]!;
        // With payments, "taken" may be another shopper's hold that can still come back.
        const back = input.withPayment ? ` If their payment doesn't go through, it comes back within ${env.RESERVATION_MINUTES} minutes.` : '';
        throw new HttpError(
          409,
          'OUT_OF_STOCK',
          short.length === 1
            ? `Someone else just took the last ${first.name}. Nothing was charged.${back}`
            : `${short.length} items in your cart were just taken. Nothing was charged.${back}`,
          { items: short },
        );
      }

      // Customer, order, order lines, the OrderPlaced event and closing the cart: one statement.
      const discountPaise = coupon?.discountPaise ?? 0;
      const totalPaise = subtotalPaise - discountPaise;
      const eventItems = items.map((it) => ({ productId: it.product_id, name: it.name, qty: it.qty, unitPricePaise: it.price_paise }));
      const placed = await tx.query<{ order_no: string }>(
        `WITH cust AS (
           INSERT INTO customers (name, email, phone) VALUES ($1::text, lower($2::text), $3::text)
           ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, phone = COALESCE(EXCLUDED.phone, customers.phone)
           RETURNING id
         ), ord AS (
           INSERT INTO orders (id, customer_id, city_code, total_paise, idempotency_key,
                               status, session_id, cart_id, reserved_until, discount_paise, coupon_code)
           SELECT $4::uuid, cust.id, $5::text, $6::int, $7::text,
                  CASE WHEN $16::boolean THEN 'pending_payment' ELSE 'confirmed' END,
                  $17::text, $14::uuid,
                  CASE WHEN $16::boolean THEN now() + make_interval(mins => $18::int) END,
                  $19::int, $20::text
             FROM cust
           RETURNING id, order_no
         ), used AS (
           UPDATE coupons SET redeemed_order_id = ord.id, redeemed_at = now()
             FROM ord WHERE coupons.code = $20::text
           RETURNING 1
         ), lines AS (
           INSERT INTO order_items (order_id, product_id, qty, unit_price_paise)
           SELECT ord.id, l.product_id, l.qty, l.unit_price_paise
             FROM ord, unnest($8::int[], $9::int[], $10::int[]) AS l(product_id, qty, unit_price_paise)
           RETURNING 1
         ), ev AS (
           INSERT INTO outbox (topic, msg_key, event_type, payload)
           SELECT $11::text, ord.id::text, $12::text, jsonb_build_object(
                    'orderId', ord.id::text,
                    'orderNumber', 'SH-' || $5::text || '-' || ord.order_no,
                    'cityCode', $5::text,
                    'customer', jsonb_build_object('name', $1::text, 'email', lower($2::text)),
                    'items', $13::jsonb,
                    'totalPaise', $6::int,
                    'discountPaise', $19::int,
                    'couponCode', $20::text,
                    'visitor', $21::text)
             FROM ord
            WHERE NOT $16::boolean -- payment mode: OrderPlaced is written when the payment is verified
           RETURNING id
         ), closed AS (
           UPDATE carts SET status = 'checked_out', updated_at = now() WHERE id = $14::uuid RETURNING 1
         )
         SELECT ord.order_no, (SELECT count(*) FROM lines) AS lines, (SELECT count(*) FROM ev) AS events,
                (SELECT count(*) FROM closed) AS closed, pg_notify($15::text, '') AS woke
           FROM ord`,
        [
          input.customer.name, input.customer.email, input.customer.phone ?? null,
          orderId, input.city, totalPaise, input.idempotencyKey,
          items.map((it) => it.product_id), items.map((it) => it.qty), items.map((it) => it.price_paise),
          env.TOPIC_ORDERS, EventType.OrderPlaced, JSON.stringify(eventItems), cartId, OUTBOX_CHANNEL,
          Boolean(input.withPayment), input.sessionId, env.RESERVATION_MINUTES,
          discountPaise, coupon?.code ?? null, visitorId(input.sessionId),
        ],
      );

      return {
        orderId,
        orderNumber: orderNumber(input.city, placed.rows[0]!.order_no),
        totalPaise,
        discountPaise,
        status: input.withPayment ? 'pending_payment' : 'confirmed',
        replayed: false,
      };
    });
  } catch (e) {
    // Two identical submits raced past findByKey: the UNIQUE(idempotency_key) loser returns the winner's order.
    if ((e as { code?: string }).code === UNIQUE_VIOLATION) {
      const winner = await findByKey(input.idempotencyKey);
      if (winner) return winner;
    }
    throw e;
  }
}
