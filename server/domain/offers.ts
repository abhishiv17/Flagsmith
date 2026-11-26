import { randomUUID } from 'node:crypto';
import { env } from '../config.js';
import { getPool, withTx } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { EventType, orderNumber } from '../lib/events.js';
import { findByKey, type CheckoutResult } from './checkout.js';
import { OUTBOX_CHANNEL } from './stock.js';
import { availabilityFor } from './cart.js';
import { visitorId } from './activity.js';
import { lockCoupon } from './coupons.js';

/**
 * Partner retailers: the same product from other shops in the shopper's city. Shown whenever our own
 * shelf can't serve the shopper (sold out, or another buyer won the last unit), so they can still
 * buy on StockHop.
 *
 * Buying from a partner is a one-item checkout. The partner's stock is taken with the same
 * conditional update as ours (qty >= n, row lock, re-checked on commit), so two shoppers racing for a
 * partner's last unit get exactly one winner. With payments on, the order is held like any other and
 * payments.ts confirms or releases it (releasing returns the units to the partner's offer).
 */

export interface Offer {
  sellerId: number;
  sellerName: string;
  rating: number;
  deliveryNote: string;
  productId: number;
  pricePaise: number;
  qty: number;
}

export async function listOffers(productId: number, city: string): Promise<Offer[]> {
  const { rows } = await getPool().query<{
    seller_id: number; name: string; rating: string; delivery_note: string; product_id: number; price_paise: number; qty: number;
  }>(
    `SELECT s.id AS seller_id, s.name, s.rating, s.delivery_note, o.product_id, o.price_paise, o.qty
       FROM seller_offers o JOIN sellers s ON s.id = o.seller_id
      WHERE o.product_id = $1 AND s.city_code = $2 AND o.qty > 0
      ORDER BY o.price_paise, s.rating DESC`,
    [productId, city],
  );
  return rows.map((r) => ({
    sellerId: r.seller_id, sellerName: r.name, rating: Number(r.rating), deliveryNote: r.delivery_note,
    productId: r.product_id, pricePaise: r.price_paise, qty: r.qty,
  }));
}

/**
 * Every place a shopper can still get this product, for the "someone else got it" popup:
 *   1. another shop in their city (partner offers),
 *   2. our StockHop store in another city (what's free to them there, after others' cart claims),
 *   3. another shop in another city.
 */
export async function whereToBuy(sessionId: string | undefined, productId: number, city: string) {
  const pool = getPool();
  const cities = await pool.query<{ code: string; name: string }>('SELECT code, name FROM cities ORDER BY name');
  const prod = await pool.query<{ name: string; price_paise: number }>('SELECT name, price_paise FROM products WHERE id = $1', [productId]);
  if (!prod.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
  const all = await Promise.all(
    cities.rows.map(async (c) => ({
      city: c.code,
      cityName: c.name,
      ours: (await availabilityFor(sessionId, c.code, productId))?.availableToYou ?? 0,
      partners: await listOffers(productId, c.code),
    })),
  );
  const here = all.find((c) => c.city === city);
  return {
    productId,
    name: prod.rows[0].name,
    ourPricePaise: prod.rows[0].price_paise,
    city,
    cityName: here?.cityName ?? city,
    sameCityPartners: here?.partners ?? [],
    otherCities: all.filter((c) => c.city !== city),
  };
}

export interface OfferCheckoutInput {
  sessionId: string;
  city: string;
  sellerId: number;
  productId: number;
  qty: number;
  customer: { name: string; email: string; phone?: string };
  idempotencyKey: string;
  withPayment: boolean;
  /** That shop's own coupon (doc/18). */
  couponCode?: string;
}

export async function offerCheckout(input: OfferCheckoutInput): Promise<CheckoutResult & { sellerName: string }> {
  const seller = await getPool().query<{ name: string; city_code: string }>('SELECT name, city_code FROM sellers WHERE id = $1', [input.sellerId]);
  const s = seller.rows[0];
  if (!s || s.city_code !== input.city) throw new HttpError(404, 'NOT_FOUND', 'That seller does not deliver in this city.');

  const existing = await findByKey(input.idempotencyKey);
  if (existing) return { ...existing, sellerName: s.name };

  return withTx(async (tx) => {
    // Coupon first (as in our checkout): its row lock never lengthens the stock row's lock window.
    const price = await tx.query<{ price_paise: number }>(
      'SELECT price_paise FROM seller_offers WHERE seller_id = $1 AND product_id = $2', [input.sellerId, input.productId],
    );
    const coupon = input.couponCode && price.rows[0]
      ? await lockCoupon(tx, input.couponCode, input.customer.email, price.rows[0].price_paise * input.qty, input.sellerId)
      : null;
    // The partner's row lock is held from here to COMMIT: one statement, as in changeStock.
    const took = await tx.query<{ price_paise: number; name: string }>(
      `UPDATE seller_offers o SET qty = o.qty - $3::int, updated_at = now()
         FROM products p
        WHERE o.seller_id = $1 AND o.product_id = $2 AND p.id = o.product_id AND o.qty >= $3::int
        RETURNING o.price_paise, p.name`,
      [input.sellerId, input.productId, input.qty],
    );
    const line = took.rows[0];
    if (!line) {
      const left = await tx.query<{ qty: number; name: string }>(
        'SELECT o.qty, p.name FROM seller_offers o JOIN products p ON p.id = o.product_id WHERE o.seller_id = $1 AND o.product_id = $2',
        [input.sellerId, input.productId],
      );
      const r = left.rows[0];
      throw new HttpError(409, 'OUT_OF_STOCK', `${s.name} just sold their last ${r?.name ?? 'one'}. Nothing was charged.`, {
        items: [{ productId: input.productId, name: r?.name ?? '', requested: input.qty, available: r?.qty ?? 0 }],
        sellerId: input.sellerId,
      });
    }

    const orderId = randomUUID();
    const discountPaise = coupon ? Math.min(coupon.discountPaise, line.price_paise * input.qty) : 0;
    const totalPaise = line.price_paise * input.qty - discountPaise;
    const placed = await tx.query<{ order_no: string }>(
      `WITH cust AS (
         INSERT INTO customers (name, email, phone) VALUES ($1::text, lower($2::text), $3::text)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, phone = COALESCE(EXCLUDED.phone, customers.phone)
         RETURNING id
       ), ord AS (
         INSERT INTO orders (id, customer_id, city_code, total_paise, idempotency_key, status, session_id, reserved_until,
                             discount_paise, coupon_code)
         SELECT $4::uuid, cust.id, $5::text, $6::int, $7::text,
                CASE WHEN $8::boolean THEN 'pending_payment' ELSE 'confirmed' END, $9::text,
                CASE WHEN $8::boolean THEN now() + make_interval(mins => $10::int) END,
                $21::int, $22::text
           FROM cust
         RETURNING id, order_no
       ), used AS (
         UPDATE coupons SET redeemed_order_id = ord.id, redeemed_at = now()
           FROM ord WHERE coupons.code = $22::text
         RETURNING 1
       ), line AS (
         INSERT INTO order_items (order_id, product_id, qty, unit_price_paise, seller_id)
         SELECT ord.id, $11::int, $12::int, $13::int, $14::int FROM ord
         RETURNING 1
       ), ev AS (
         INSERT INTO outbox (topic, msg_key, event_type, payload)
         SELECT $15::text, ord.id::text, $16::text, jsonb_build_object(
                  'orderId', ord.id::text, 'orderNumber', 'SH-' || $5::text || '-' || ord.order_no, 'cityCode', $5::text,
                  'customer', jsonb_build_object('name', $1::text, 'email', lower($2::text)),
                  'items', jsonb_build_array(jsonb_build_object('productId', $11::int, 'name', $17::text, 'qty', $12::int,
                                                                'unitPricePaise', $13::int, 'seller', $18::text,
                                                                'sellerId', $14::int)),
                  'totalPaise', $6::int, 'visitor', $20::text, 'discountPaise', $21::int, 'couponCode', $22::text)
           FROM ord WHERE NOT $8::boolean
         RETURNING id
       )
       SELECT ord.order_no, (SELECT count(*) FROM line) AS lines, (SELECT count(*) FROM ev) AS events,
              (SELECT count(*) FROM used) AS coupons,
              pg_notify($19::text, '') AS woke
         FROM ord`,
      [
        input.customer.name, input.customer.email, input.customer.phone ?? null,
        orderId, input.city, totalPaise, input.idempotencyKey, input.withPayment, input.sessionId, env.RESERVATION_MINUTES,
        input.productId, input.qty, line.price_paise, input.sellerId,
        env.TOPIC_ORDERS, EventType.OrderPlaced, line.name, s.name, OUTBOX_CHANNEL, visitorId(input.sessionId),
        discountPaise, coupon?.code ?? null,
      ],
    );
    return {
      orderId,
      orderNumber: orderNumber(input.city, placed.rows[0]!.order_no),
      totalPaise,
      discountPaise,
      status: input.withPayment ? 'pending_payment' : 'confirmed',
      replayed: false,
      sellerName: s.name,
    };
  });
}
