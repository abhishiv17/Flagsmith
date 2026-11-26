import { Router, type Request } from 'express';
import { env } from '../config.js';
import { z } from 'zod';
import { getPool } from '../lib/db.js';
import { CityCode, HttpError, parse } from '../lib/http.js';
import { orderNumber } from '../lib/events.js';
import { maskEmail } from '../lib/log.js';
import { addItem, getCart, setItemQty } from '../domain/cart.js';
import { checkout } from '../domain/checkout.js';
import { attachGatewayOrder, cancelPayment, confirmPayment, sweepExpiredHolds } from '../domain/payments.js';
import { paymentsEnabled } from '../lib/razorpay-test.js';
import { listOffers, offerCheckout, whereToBuy } from '../domain/offers.js';
import { previewCoupon, publicCoupon } from '../domain/coupons.js';
import { currentAccount, shopperKey } from '../domain/accounts.js';

/** Cart, checkout and orders (doc/05). */
export const shop = Router();

const cityQ = z.object({ city: CityCode });
const productParam = z.object({ productId: z.coerce.number().int().positive() });

shop.get('/cart', async (req, res) => {
  const { city } = parse(cityQ, req.query);
  res.json(await getCart(await shopperKey(req), city));
});

shop.post('/cart/items', async (req, res) => {
  const b = parse(
    z.object({ city: CityCode, productId: z.number().int().positive(), qty: z.number().int().min(1).max(10).default(1) }),
    req.body,
  );
  const sid = await shopperKey(req);
  await addItem(sid, b.city, b.productId, b.qty);
  res.json(await getCart(sid, b.city));
});

shop.patch('/cart/items/:productId', async (req, res) => {
  const { productId } = parse(productParam, req.params);
  const b = parse(z.object({ city: CityCode, qty: z.number().int().min(0).max(10) }), req.body);
  const sid = await shopperKey(req);
  await setItemQty(sid, b.city, productId, b.qty);
  res.json(await getCart(sid, b.city));
});

shop.delete('/cart/items/:productId', async (req, res) => {
  const { productId } = parse(productParam, req.params);
  const { city } = parse(cityQ, req.query);
  const sid = await shopperKey(req);
  await setItemQty(sid, city, productId, 0);
  res.json(await getCart(sid, city));
});

const checkoutBody = z.object({
  city: CityCode,
  customer: z.object({
    name: z.string().trim().min(2).max(80),
    email: z.email().max(120),
    phone: z.string().regex(/^\d{10}$/, '10-digit phone').optional(),
  }),
  idempotencyKey: z.uuid(),
  couponCode: z.string().trim().max(40).optional().transform((v) => v || undefined),
});

/**
 * Accounts (doc/17): when signed in, the order goes to the account's verified email, whatever was
 * typed. Loyalty coupons belong to one email, so (with COUPON_REQUIRES_SIGN_IN) only a shopper
 * signed in with that email can use one: knowing someone's email and code is no longer enough.
 */
async function verifiedEmail(req: Request, typed: string, couponCode?: string): Promise<string> {
  const acct = await currentAccount(req);
  if (couponCode && env.COUPON_REQUIRES_SIGN_IN && !acct) {
    throw new HttpError(401, 'SIGN_IN_REQUIRED', 'Sign in with the email this coupon was sent to, then apply it. It takes 20 seconds.');
  }
  return acct ? acct.email : typed;
}

/** A coupon link was opened: show eligibility for this account, without exposing the recipient. */
shop.get('/coupons/:code', async (req, res) => {
  const code = parse(z.string().trim().min(3).max(40), req.params.code);
  res.set('Cache-Control', 'no-store');
  res.json(await publicCoupon(code, (await currentAccount(req))?.email ?? null));
});

/**
 * Would this coupon work for this email? On the current cart, or (sellerId + productId) on buying
 * that item from a partner shop (doc/18). Read-only; checkout re-checks under a lock.
 */
shop.post('/coupons/preview', async (req, res) => {
  const b = parse(
    z.object({
      city: CityCode, email: z.email().max(120), code: z.string().trim().min(3).max(40),
      sellerId: z.number().int().positive().optional(), productId: z.number().int().positive().optional(),
      qty: z.number().int().min(1).max(10).default(1),
    }),
    req.body,
  );
  const email = await verifiedEmail(req, b.email, b.code);
  let subtotalPaise: number;
  if (b.sellerId && b.productId) {
    const o = await getPool().query<{ price_paise: number }>(
      'SELECT price_paise FROM seller_offers WHERE seller_id = $1 AND product_id = $2', [b.sellerId, b.productId],
    );
    if (!o.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'That shop doesn’t sell this item.');
    subtotalPaise = o.rows[0].price_paise * b.qty;
  } else {
    subtotalPaise = (await getCart(await shopperKey(req), b.city)).subtotalPaise;
  }
  res.set('Cache-Control', 'no-store');
  res.json({ ...(await previewCoupon(b.code, email, subtotalPaise, b.sellerId ?? null)), subtotalPaise });
});

shop.post('/checkout', async (req, res) => {
  const b = parse(checkoutBody, req.body);
  const withPayment = paymentsEnabled();
  // Free any expired holds first, so stock nobody paid for is buyable again.
  if (withPayment) await sweepExpiredHolds();
  b.customer.email = await verifiedEmail(req, b.customer.email, b.couponCode);
  const result = await checkout({ sessionId: await shopperKey(req), ...b, withPayment });
  // Pending orders get a Razorpay Test order to pay; if the gateway fails, the hold is released.
  const payment = result.status === 'pending_payment' ? await attachGatewayOrder(result.orderId) : undefined;
  res.status(result.replayed ? 200 : 201).json({
    orderId: result.orderId,
    orderNumber: result.orderNumber,
    totalPaise: result.totalPaise,
    discountPaise: result.discountPaise ?? 0,
    status: result.status,
    ...(payment ? { payment } : {}),
  });
});

/** Same product from partner retailers in this city (shown when our shelf can't serve the shopper). */
shop.get('/offers', async (req, res) => {
  const { productId, city } = parse(z.object({ productId: z.coerce.number().int().positive(), city: CityCode }), req.query);
  res.set('Cache-Control', 'no-store');
  res.json({ items: await listOffers(productId, city) });
});

/** Every place this shopper can still get the product: same city other shop, our other cities, other shops there. */
shop.get('/where-to-buy', async (req, res) => {
  const { productId, city } = parse(z.object({ productId: z.coerce.number().int().positive(), city: CityCode }), req.query);
  res.set('Cache-Control', 'no-store');
  res.json(await whereToBuy(await shopperKey(req), productId, city));
});

const offerCheckoutBody = checkoutBody.extend({
  sellerId: z.number().int().positive(),
  productId: z.number().int().positive(),
  qty: z.number().int().min(1).max(10).default(1),
});

/** Buy one item from a partner retailer: same hold → pay → confirm/release flow as our own stock. */
shop.post('/checkout/offer', async (req, res) => {
  const b = parse(offerCheckoutBody, req.body);
  const withPayment = paymentsEnabled();
  if (withPayment) await sweepExpiredHolds();
  b.customer.email = await verifiedEmail(req, b.customer.email, b.couponCode);
  const result = await offerCheckout({ sessionId: await shopperKey(req), ...b, withPayment });
  const payment = result.status === 'pending_payment' ? await attachGatewayOrder(result.orderId) : undefined;
  res.status(result.replayed ? 200 : 201).json({
    orderId: result.orderId,
    orderNumber: result.orderNumber,
    totalPaise: result.totalPaise,
    discountPaise: result.discountPaise ?? 0,
    status: result.status,
    sellerName: result.sellerName,
    ...(payment ? { payment } : {}),
  });
});

const verifyBody = z.object({
  orderId: z.uuid(),
  gatewayOrderId: z.string().regex(/^order_[A-Za-z0-9]+$/),
  paymentId: z.string().regex(/^pay_[A-Za-z0-9]+$/),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Razorpay Checkout's success callback lands here; the server verifies before confirming. */
shop.post('/payments/verify', async (req, res) => {
  const b = parse(verifyBody, req.body);
  res.json(await confirmPayment({ sessionId: await shopperKey(req), ...b }));
});

/** Checkout closed or payment failed: release the hold now. */
shop.post('/payments/cancel', async (req, res) => {
  const { orderId } = parse(z.object({ orderId: z.uuid() }), req.body);
  res.json(await cancelPayment(await shopperKey(req), orderId));
});

shop.get('/orders/:orderId', async (req, res) => {
  const { orderId } = parse(z.object({ orderId: z.uuid() }), req.params);
  const pool = getPool();
  const o = await pool.query<{
    id: string; order_no: string; city_code: string; status: string; total_paise: number; created_at: Date; gateway_payment_id: string | null;
  }>(
    'SELECT id, order_no, city_code, status, total_paise, created_at, gateway_payment_id FROM orders WHERE id = $1',
    [orderId],
  );
  const order = o.rows[0];
  if (!order) throw new HttpError(404, 'NOT_FOUND', 'Order not found');

  const [items, note] = await Promise.all([
    pool.query<{ product_id: number; sku: string; name: string; image_key: string; qty: number; unit_price_paise: number; seller: string | null }>(
      `SELECT oi.product_id, p.sku, p.name, p.image_key, oi.qty, oi.unit_price_paise, s.name AS seller
         FROM order_items oi JOIN products p ON p.id = oi.product_id
         LEFT JOIN sellers s ON s.id = oi.seller_id
        WHERE oi.order_id = $1`,
      [orderId],
    ),
    // Written by the notifier Kafka consumer, not by checkout: proof the consumer reacted.
    pool.query<{ recipient: string; created_at: Date }>(
      'SELECT recipient, created_at FROM notifications WHERE order_id = $1 ORDER BY id LIMIT 1',
      [orderId],
    ),
  ]);
  const n = note.rows[0];
  res.set('Cache-Control', 'no-store');
  res.json({
    orderId: order.id,
    orderNumber: orderNumber(order.city_code, order.order_no),
    city: order.city_code,
    status: order.status,
    items: items.rows.map((i) => ({
      productId: i.product_id, sku: i.sku, name: i.name, imageKey: i.image_key, qty: i.qty, unitPricePaise: i.unit_price_paise,
      seller: i.seller, // null = StockHop's own store
    })),
    totalPaise: order.total_paise,
    createdAt: order.created_at,
    paymentId: order.gateway_payment_id,
    confirmationSent: Boolean(n),
    confirmationAt: n?.created_at ?? null,
    confirmationTo: n ? maskEmail(n.recipient) : null,
  });
});
