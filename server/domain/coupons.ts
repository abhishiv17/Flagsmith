import { randomInt } from 'node:crypto';
import { env } from '../config.js';
import { getPool, type Tx } from '../lib/db.js';
import { HttpError } from '../lib/http.js';

/**
 * Loyalty coupons (doc/16). The retailer gives one to a top customer from the ClickHouse dashboard;
 * the customer types it at checkout with the same email.
 *
 * Rules: one customer (email), one use, a percentage off, an expiry date, optional cap. A coupon with
 * a seller (doc/18) is that shop's: it only works when buying from that shop, and a coupon without
 * one only works on our own store's cart. Checked and locked inside the checkout transaction (lockCoupon) BEFORE stock rows
 * are locked; marked used in the same statement that writes the order.
 */

export interface Coupon {
  code: string; customerEmail: string; percentOff: number; maxDiscountPaise: number | null;
  reason: string; expiresAt: string; createdAt: string; redeemedOrderId: string | null; redeemedAt: string | null;
  /** Where the coupon link opens: this product, in this city. */
  productId: number | null; city: string | null; link: string | null;
  /** Issued by this partner shop (doc/18); null = our own store. */
  sellerId: number | null; sellerName: string | null;
}

type Row = {
  code: string; customer_email: string; percent_off: number; max_discount_paise: number | null; reason: string;
  expires_at: Date; created_at: Date; redeemed_order_id: string | null; redeemed_at: Date | null;
  product_id: number | null; city_code: string | null; seller_id: number | null; seller_name?: string | null;
};
const SELECT_COUPON = 'SELECT c.*, s.name AS seller_name FROM coupons c LEFT JOIN sellers s ON s.id = c.seller_id';

/** The link the retailer sends: opens the product in the customer's city, carrying the code. */
export const couponLink = (r: Pick<Row, 'code' | 'product_id' | 'city_code'>) =>
  r.product_id
    ? `/p/${r.product_id}?${new URLSearchParams({ ...(r.city_code ? { city: r.city_code } : {}), coupon: r.code })}`
    : `/shop?${new URLSearchParams({ ...(r.city_code ? { city: r.city_code } : {}), coupon: r.code })}`;
const toCoupon = (r: Row): Coupon => ({
  code: r.code, customerEmail: r.customer_email, percentOff: r.percent_off, maxDiscountPaise: r.max_discount_paise,
  reason: r.reason, expiresAt: r.expires_at.toISOString(), createdAt: r.created_at.toISOString(),
  redeemedOrderId: r.redeemed_order_id, redeemedAt: r.redeemed_at?.toISOString() ?? null,
  productId: r.product_id, city: r.city_code, link: couponLink(r),
  sellerId: r.seller_id, sellerName: r.seller_name ?? null,
});

// No 0/O/1/I: codes get read out loud and typed on phones.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = (prefix: string) =>
  `${prefix}-${Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;

export const normaliseCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, '');

export function discountFor(c: Pick<Coupon, 'percentOff' | 'maxDiscountPaise'>, subtotalPaise: number): number {
  // Whole rupees, rounded down: "you save ₹249", never ₹249.90.
  const d = Math.floor((subtotalPaise * c.percentOff) / 100 / 100) * 100;
  return Math.min(d, c.maxDiscountPaise ?? d, subtotalPaise);
}

/** Why a code can't be used (null = fine). Messages are shown to the shopper. */
function problem(c: Row | undefined, email: string, sellerId: number | null): string | null {
  if (!c) return 'That coupon code doesn’t exist. Check the spelling.';
  if (c.customer_email.toLowerCase() !== email.trim().toLowerCase()) return 'This coupon was issued to a different email address.';
  if ((c.seller_id ?? null) !== sellerId) {
    return c.seller_id
      ? `This coupon is from ${c.seller_name ?? 'a partner shop'}. It works when you buy from them (open the link it came with).`
      : 'This coupon is for StockHop’s own store, not a partner shop.';
  }
  if (c.redeemed_order_id) return 'This coupon has already been used.';
  if (c.expires_at.getTime() < Date.now()) return 'This coupon has expired.';
  return null;
}

/** Inside checkout: lock the coupon row, validate it, return the discount. Throws 409 COUPON_INVALID. */
export async function lockCoupon(tx: Tx, code: string, email: string, subtotalPaise: number, sellerId: number | null = null) {
  const { rows } = await tx.query<Row>(`${SELECT_COUPON} WHERE c.code = $1 FOR UPDATE OF c`, [normaliseCode(code)]);
  const why = problem(rows[0], email, sellerId);
  if (why) throw new HttpError(409, 'COUPON_INVALID', why);
  const c = toCoupon(rows[0]!);
  return { code: c.code, percentOff: c.percentOff, discountPaise: discountFor(c, subtotalPaise) };
}

/** Before submitting: would this code work for this email and subtotal? Read-only. */
export async function previewCoupon(code: string, email: string, subtotalPaise: number, sellerId: number | null = null) {
  const { rows } = await getPool().query<Row>(`${SELECT_COUPON} WHERE c.code = $1`, [normaliseCode(code)]);
  const why = problem(rows[0], email, sellerId);
  if (why) throw new HttpError(409, 'COUPON_INVALID', why);
  const c = toCoupon(rows[0]!);
  return { code: c.code, percentOff: c.percentOff, discountPaise: discountFor(c, subtotalPaise), expiresAt: c.expiresAt };
}

/** Retailer gives a coupon to one customer. */
export async function issueCoupon(input: {
  email: string; percentOff: number; days: number; maxDiscountPaise?: number | null; reason?: string;
  productId?: number | null; city?: string | null; sellerId?: number | null;
}) {
  if (input.percentOff > env.COUPON_PERCENT_MAX) {
    throw new HttpError(400, 'VALIDATION', `Coupons are capped at ${env.COUPON_PERCENT_MAX}% off.`);
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { rows } = await getPool().query<Row>(
        `WITH c AS (
           INSERT INTO coupons (code, customer_email, percent_off, max_discount_paise, reason, expires_at, product_id, city_code, seller_id)
           VALUES ($1, lower($2), $3, $4, $5, now() + make_interval(days => $6::int), $7, $8, $9)
           RETURNING *)
         SELECT c.*, s.name AS seller_name FROM c LEFT JOIN sellers s ON s.id = c.seller_id`,
        [randomCode(`THANKS${input.percentOff}`), input.email.trim(), input.percentOff, input.maxDiscountPaise ?? null,
          input.reason ?? '', input.days, input.productId ?? null, input.city ?? null, input.sellerId ?? null],
      );
      return toCoupon(rows[0]!);
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e; // code collision: try another
    }
  }
  throw new HttpError(503, 'BUSY', 'Could not generate a unique code. Try again.');
}

/**
 * What a shopper who opened a coupon link may see: the offer and whether their own
 * signed-in account can use it. Never reveal the recipient's email.
 */
export async function publicCoupon(code: string, accountEmail: string | null) {
  const { rows } = await getPool().query<Row & { product_name: string | null }>(
    `SELECT c.*, p.name AS product_name, s.name AS seller_name
       FROM coupons c LEFT JOIN products p ON p.id = c.product_id LEFT JOIN sellers s ON s.id = c.seller_id
      WHERE c.code = $1`,
    [normaliseCode(code)],
  );
  const c = rows[0];
  if (!c) throw new HttpError(404, 'NOT_FOUND', 'That coupon code doesn’t exist.');
  return {
    code: c.code, percentOff: c.percent_off, maxDiscountPaise: c.max_discount_paise, expiresAt: c.expires_at.toISOString(),
    productId: c.product_id, productName: c.product_name, city: c.city_code,
    sellerId: c.seller_id, sellerName: c.seller_name ?? null,
    status: c.redeemed_order_id ? 'used' : c.expires_at.getTime() < Date.now() ? 'expired' : 'open',
    eligible: accountEmail === null ? null : c.customer_email.toLowerCase() === accountEmail.toLowerCase(),
  };
}

/** Coupons, newest first: one shop's (sellerId), or all of them (undefined). */
export async function listCoupons(limit = 100, sellerId?: number): Promise<Coupon[]> {
  const { rows } = await getPool().query<Row>(
    `${SELECT_COUPON} WHERE ($2::int IS NULL OR c.seller_id = $2::int) ORDER BY c.created_at DESC LIMIT $1`,
    [limit, sellerId ?? null],
  );
  return rows.map(toCoupon);
}

/** A held (payment) order was cancelled or expired: its coupon becomes usable again. */
export async function releaseCoupon(tx: Pick<Tx, 'query'>, orderId: string): Promise<void> {
  await tx.query('UPDATE coupons SET redeemed_order_id = NULL, redeemed_at = NULL WHERE redeemed_order_id = $1', [orderId]);
}
