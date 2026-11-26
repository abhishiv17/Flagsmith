import { getPool } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { log, maskEmail } from '../lib/log.js';
import type { Account } from './accounts.js';

/**
 * "Notify me when it's back" (doc/17). Signed-in shoppers only: an alert needs someone to tell.
 * The notifier calls notifyBackInStock() for every inventory.changed event; waiting alerts for that
 * product and city are marked notified exactly once (the UPDATE only touches rows not yet notified,
 * so a redelivered or replayed Kafka event changes nothing).
 */

export interface BackInStockAlert {
  id: number;
  productId: number;
  name: string;
  sku: string;
  imageKey: string;
  city: string;
  createdAt: Date;
  notifiedAt: Date | null;
  /** Stock in that city right now. */
  qtyNow: number;
}

export async function createAlert(acct: Account, productId: number, city: string) {
  const prod = await getPool().query('SELECT 1 FROM inventory WHERE product_id = $1 AND city_code = $2', [productId, city]);
  if (!prod.rowCount) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
  await getPool().query(
    `INSERT INTO back_in_stock_alerts (customer_id, product_id, city_code) VALUES ($1, $2, $3)
     ON CONFLICT (customer_id, product_id, city_code) WHERE notified_at IS NULL DO NOTHING`,
    [acct.id, productId, city],
  );
  return listAlerts(acct);
}

export async function deleteAlert(acct: Account, id: number) {
  await getPool().query('DELETE FROM back_in_stock_alerts WHERE id = $1 AND customer_id = $2', [id, acct.id]);
  return listAlerts(acct);
}

/** Waiting alerts, plus ones notified in the last 7 days. */
export async function listAlerts(acct: Account): Promise<BackInStockAlert[]> {
  // Catch-up: the notifier is the primary path, but if it was down or running old code when the
  // stock came back, the shopper should still see it. Stock above 0 that changed after the alert was
  // set means it came back.
  const caught = await getPool().query<{ name: string; city_code: string }>(
    `UPDATE back_in_stock_alerts a SET notified_at = now(), notified_qty = i.qty
       FROM inventory i, products p
      WHERE a.customer_id = $1 AND a.notified_at IS NULL
        AND i.product_id = a.product_id AND i.city_code = a.city_code AND i.qty > 0 AND i.updated_at > a.created_at
        AND p.id = a.product_id
      RETURNING p.name, a.city_code`,
    [acct.id],
  );
  for (const r of caught.rows) log.info('alerts: back in stock (caught up on read)', { product: r.name, city: r.city_code, to: maskEmail(acct.email) });

  const { rows } = await getPool().query<{
    id: string; product_id: number; name: string; sku: string; image_key: string; city_code: string;
    created_at: Date; notified_at: Date | null; qty_now: number;
  }>(
    `SELECT a.id, a.product_id, p.name, p.sku, p.image_key, a.city_code, a.created_at, a.notified_at, COALESCE(i.qty, 0) AS qty_now
       FROM back_in_stock_alerts a
       JOIN products p ON p.id = a.product_id
       LEFT JOIN inventory i ON i.product_id = a.product_id AND i.city_code = a.city_code
      WHERE a.customer_id = $1 AND (a.notified_at IS NULL OR a.notified_at > now() - interval '7 days')
      ORDER BY a.notified_at DESC NULLS LAST, a.created_at DESC`,
    [acct.id],
  );
  return rows.map((r) => ({
    id: Number(r.id), productId: r.product_id, name: r.name, sku: r.sku, imageKey: r.image_key, city: r.city_code,
    createdAt: r.created_at, notifiedAt: r.notified_at, qtyNow: r.qty_now,
  }));
}

/** Called by the notifier for each stock change. Returns how many shoppers were told. */
export async function notifyBackInStock(eventId: number, e: { productId: number; cityCode: string; qty: number; doc?: { name?: string } }) {
  if (e.qty <= 0) return 0;
  const { rows } = await getPool().query<{ email: string }>(
    `UPDATE back_in_stock_alerts a SET notified_at = now(), notified_event_id = $3, notified_qty = $4
       FROM customers c
      WHERE a.product_id = $1 AND a.city_code = $2 AND a.notified_at IS NULL AND c.id = a.customer_id
      RETURNING c.email`,
    [e.productId, e.cityCode, eventId, e.qty],
  );
  for (const r of rows) {
    // Simulated email, like order confirmations.
    log.info('notifier: 📧 back in stock', { product: e.doc?.name ?? e.productId, city: e.cityCode, to: maskEmail(r.email) });
  }
  return rows.length;
}
