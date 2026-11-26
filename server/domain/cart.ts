import { env } from '../config.js';
import { getPool, withTx, type Tx } from '../lib/db.js';
import { HttpError } from '../lib/http.js';

/**
 * Guest carts: one active cart per (session, city) (doc/02 G10).
 *
 * Cart claims: adding to a cart *claims* units for CART_CLAIM_MINUTES of cart activity, so the
 * last unit goes to whoever adds it first and everyone after is told straight away (with partner
 * retailers to buy from instead). Claims are soft: they never change inventory. Checkout is still
 * the only place that allocates stock (G9), so an expired claim can never cause an oversell.
 * The check runs under the inventory row lock, so two shoppers adding the last unit at the same
 * moment can't both get it.
 */

/** Why a shopper can't add more of a product right now. */
export type UnavailableReason = 'sold_out' | 'being_paid_for' | 'in_someone_cart' | 'already_yours';

/** Units this shopper may still add: shelf qty minus fresh claims in other shoppers' carts. */
async function claimable(tx: Tx, cartId: string, productId: number, city: string) {
  // 1. Take the row lock in its OWN statement. A waiting SELECT ... FOR UPDATE only re-reads the
  //    locked row when it wakes; any subquery in the same statement keeps its old snapshot and would
  //    miss the claim the previous shopper just committed (found by payment:race: 2 of 5 got the
  //    last unit). Under READ COMMITTED the next statement takes a fresh snapshot, so it sees it.
  const locked = await tx.query('SELECT 1 FROM inventory WHERE product_id = $1 AND city_code = $2 FOR UPDATE', [productId, city]);
  if (locked.rowCount === 0) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
  // 2. Now count, with everything committed before we got the lock.
  const { rows } = await tx.query<{ qty: number; others: string; mine: number; paying: string; name: string }>(
    `SELECT i.qty, p.name,
            COALESCE((SELECT sum(ci.qty) FROM cart_items ci JOIN carts c ON c.id = ci.cart_id
                       WHERE ci.product_id = $2 AND c.city_code = $3 AND c.status = 'active' AND c.id <> $1
                         AND c.updated_at > now() - make_interval(mins => $4::int)), 0) AS others,
            COALESCE((SELECT qty FROM cart_items WHERE cart_id = $1 AND product_id = $2), 0) AS mine,
            (SELECT count(*) FROM orders o JOIN order_items oi ON oi.order_id = o.id
              WHERE o.status = 'pending_payment' AND o.city_code = $3 AND oi.product_id = $2 AND oi.seller_id IS NULL) AS paying
       FROM inventory i JOIN products p ON p.id = i.product_id
      WHERE i.product_id = $2 AND i.city_code = $3`,
    [cartId, productId, city, env.CART_CLAIM_MINUTES],
  );
  const r = rows[0];
  if (!r) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
  const others = Number(r.others);
  return { name: r.name, shelf: r.qty, others, mine: r.mine, paying: Number(r.paying), free: Math.max(0, r.qty - others) };
}

function unavailable(c: Awaited<ReturnType<typeof claimable>>, productId: number, city: string): HttpError {
  // Signed in on two devices: the cart is shared, so the second add finds the unit already theirs.
  const reason: UnavailableReason =
    c.mine > 0 && c.mine >= c.free ? 'already_yours' : c.shelf > 0 ? 'in_someone_cart' : c.paying > 0 ? 'being_paid_for' : 'sold_out';
  const message =
    reason === 'already_yours'
      ? `You already have ${c.mine === 1 ? 'the last' : `all ${c.mine}`} ${c.name} in your cart${c.mine === c.shelf ? '' : ', and the rest are in other carts'}.`
      : reason === 'in_someone_cart'
      ? c.shelf > 1
        ? `Other shoppers already have all ${c.shelf} ${c.name} in their carts.`
        : `Someone else already has the last ${c.name} in their cart.`
      : reason === 'being_paid_for'
        ? `Someone else is paying for the last ${c.name} right now.`
        : `${c.name} is sold out here.`;
  return new HttpError(409, 'OUT_OF_STOCK', message, {
    reason, productId, name: c.name, city, available: c.free, inYourCart: c.mine,
  });
}

export interface CartView {
  cartId: string | null;
  city: string;
  items: {
    productId: number; sku: string; name: string; imageKey: string; qty: number;
    unitPricePaise: number; available: number; shortBy: number;
  }[];
  subtotalPaise: number;
  otherCityCarts: { city: string; itemCount: number }[];
}

export async function getCart(sessionId: string, city: string): Promise<CartView> {
  const pool = getPool();
  const cart = await pool.query<{ id: string }>(
    `SELECT id FROM carts WHERE session_id = $1 AND city_code = $2 AND status = 'active'`,
    [sessionId, city],
  );
  const cartId = cart.rows[0]?.id ?? null;

  const items = cartId
    ? (
        await pool.query<{
          product_id: number; sku: string; name: string; image_key: string; qty: number; price_paise: number; available: number;
        }>(
          `SELECT ci.product_id, p.sku, p.name, p.image_key, ci.qty, p.price_paise, COALESCE(i.qty, 0) AS available
             FROM cart_items ci
             JOIN products p ON p.id = ci.product_id
             LEFT JOIN inventory i ON i.product_id = ci.product_id AND i.city_code = $2
            WHERE ci.cart_id = $1
            ORDER BY ci.added_at`,
          [cartId, city],
        )
      ).rows
    : [];

  const others = await pool.query<{ city_code: string; n: string }>(
    `SELECT c.city_code, COALESCE(SUM(ci.qty), 0) AS n
       FROM carts c JOIN cart_items ci ON ci.cart_id = c.id
      WHERE c.session_id = $1 AND c.status = 'active' AND c.city_code <> $2
      GROUP BY c.city_code`,
    [sessionId, city],
  );

  return {
    cartId,
    city,
    items: items.map((r) => ({
      productId: r.product_id, sku: r.sku, name: r.name, imageKey: r.image_key, qty: r.qty,
      unitPricePaise: r.price_paise, available: r.available, shortBy: Math.max(0, r.qty - r.available),
    })),
    subtotalPaise: items.reduce((sum, r) => sum + r.qty * r.price_paise, 0),
    otherCityCarts: others.rows.map((r) => ({ city: r.city_code, itemCount: Number(r.n) })),
  };
}

async function ensureCart(sessionId: string, city: string): Promise<string> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO carts (session_id, city_code) VALUES ($1, $2)
     ON CONFLICT (session_id, city_code) WHERE status = 'active' DO NOTHING`,
    [sessionId, city],
  );
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM carts WHERE session_id = $1 AND city_code = $2 AND status = 'active'`,
    [sessionId, city],
  );
  return rows[0]!.id;
}

export async function addItem(sessionId: string, city: string, productId: number, qty: number) {
  const cartId = await ensureCart(sessionId, city);
  await withTx(async (tx) => {
    const c = await claimable(tx, cartId, productId, city);
    // How many more this shopper may claim: what's free after others' claims, minus what they hold.
    if (env.CART_CLAIMS !== 'off' && c.mine + qty > c.free) throw unavailable(c, productId, city);
    await tx.query(
      `INSERT INTO cart_items (cart_id, product_id, qty) VALUES ($1, $2, LEAST($3, 10))
       ON CONFLICT (cart_id, product_id) DO UPDATE SET qty = LEAST(cart_items.qty + EXCLUDED.qty, 10)`,
      [cartId, productId, qty],
    );
    await tx.query('UPDATE carts SET updated_at = now() WHERE id = $1', [cartId]);
  });
}

export async function setItemQty(sessionId: string, city: string, productId: number, qty: number) {
  const cartId = await ensureCart(sessionId, city);
  if (qty <= 0) {
    await getPool().query('DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2', [cartId, productId]);
    await touch(cartId);
    return;
  }
  await withTx(async (tx) => {
    const c = await claimable(tx, cartId, productId, city);
    if (env.CART_CLAIMS !== 'off' && qty > c.mine && qty > c.free) throw unavailable(c, productId, city); // only increases are checked
    await tx.query(
      `INSERT INTO cart_items (cart_id, product_id, qty) VALUES ($1, $2, LEAST($3, 10))
       ON CONFLICT (cart_id, product_id) DO UPDATE SET qty = EXCLUDED.qty`,
      [cartId, productId, qty],
    );
    await tx.query('UPDATE carts SET updated_at = now() WHERE id = $1', [cartId]);
  });
}

/**
 * Availability *for this shopper* (product page, before they add): shelf count, units claimed in
 * other shoppers' carts, and whether one is being paid for.
 */
export async function availabilityFor(sessionId: string | undefined, city: string, productId: number) {
  const { rows } = await getPool().query<{ qty: number; others: string; paying: string }>(
    `SELECT i.qty,
            COALESCE((SELECT sum(ci.qty) FROM cart_items ci JOIN carts c ON c.id = ci.cart_id
                       WHERE ci.product_id = $2 AND c.city_code = $3 AND c.status = 'active'
                         AND c.session_id IS DISTINCT FROM $1
                         AND c.updated_at > now() - make_interval(mins => $4::int)), 0) AS others,
            (SELECT count(*) FROM orders o JOIN order_items oi ON oi.order_id = o.id
              WHERE o.status = 'pending_payment' AND o.city_code = $3 AND oi.product_id = $2 AND oi.seller_id IS NULL) AS paying
       FROM inventory i WHERE i.product_id = $2 AND i.city_code = $3`,
    [sessionId ?? null, productId, city, env.CART_CLAIM_MINUTES],
  );
  const r = rows[0];
  if (!r) return null;
  const inOtherCarts = Number(r.others);
  const free = Math.max(0, r.qty - inOtherCarts);
  const reason: UnavailableReason | null = free > 0 ? null : r.qty > 0 ? 'in_someone_cart' : Number(r.paying) > 0 ? 'being_paid_for' : 'sold_out';
  return { shelf: r.qty, inOtherCarts, availableToYou: free, reason };
}

async function touch(cartId: string) {
  await getPool().query('UPDATE carts SET updated_at = now() WHERE id = $1', [cartId]);
}
