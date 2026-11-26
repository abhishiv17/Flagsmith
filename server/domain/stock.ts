import { env } from '../config.js';
import type { Tx } from '../lib/db.js';
import { EventType, inventoryKey, type StockReason } from '../lib/events.js';

/** NOTIFY channel the relay LISTENs on; notifications are delivered when the writing transaction commits. */
export const OUTBOX_CHANNEL = 'outbox_new';

/**
 * THE ONLY code allowed to change inventory.qty (invariant I-1).
 * Conditional update + outbox row, inside the caller's transaction.
 *
 * Why this can't oversell: the UPDATE takes a row lock; a concurrent buyer waits, then
 * PostgreSQL re-evaluates `qty + delta >= 0` against the committed row (READ COMMITTED),
 * so the second buyer updates 0 rows. See doc/03 §4.1.
 *
 * One statement, one round trip (doc/12 F4): the row lock is held from this UPDATE until COMMIT, so
 * every extra round trip while it is held slows every other buyer of the same item. The update, the
 * full InventoryChanged event (same payload shape as before: product doc carried in the event,
 * ADR-4) and the relay wake-up all happen in this single CTE.
 *
 * @returns the new qty/version, or null if the change would make qty negative (nothing written).
 */
export async function changeStock(
  tx: Tx,
  args: { productId: number; city: string; delta: number; reason: StockReason; orderId?: string | null },
): Promise<{ qty: number; version: number } | null> {
  const { productId, city, delta, reason, orderId = null } = args;

  const res = await tx.query<{ qty: number; version: string }>(
    `WITH upd AS (
       UPDATE inventory
          SET qty = qty + $3::int, version = nextval('inventory_version_seq'), updated_at = now()
        WHERE product_id = $1::int AND city_code = $2::text AND qty + $3::int >= 0
        RETURNING product_id, city_code, qty, version
     ), ev AS (
       INSERT INTO outbox (topic, msg_key, event_type, payload)
       SELECT $4::text, $5::text, $6::text, jsonb_build_object(
                'productId', upd.product_id, 'cityCode', upd.city_code, 'qty', upd.qty, 'delta', $3::int,
                'version', upd.version, 'reason', $7::text, 'orderId', $8::text,
                'doc', jsonb_build_object(
                  'sku', p.sku, 'name', p.name, 'brand', p.brand, 'category', p.category,
                  'description', p.description, 'tags', to_jsonb(p.tags), 'pricePaise', p.price_paise,
                  'imageKey', p.image_key, 'cityName', c.name,
                  'features', to_jsonb(p.features), 'uses', to_jsonb(p.uses),
                  'about', p.about, 'specs', p.specs, 'inBox', to_jsonb(p.in_box), 'colour', p.colour,
                  'connectivity', to_jsonb(p.connectivity), 'waterRating', p.water_rating,
                  'batteryHours', p.battery_hours, 'weightG', p.weight_g))
         FROM upd
         JOIN products p ON p.id = upd.product_id
         JOIN cities c ON c.code = upd.city_code
       RETURNING id
     )
     SELECT upd.qty, upd.version, (SELECT count(*) FROM ev) AS events, pg_notify($9::text, '') AS woke
       FROM upd`,
    [productId, city, delta, env.TOPIC_INVENTORY, inventoryKey(productId, city), EventType.InventoryChanged,
      reason, orderId, OUTBOX_CHANNEL],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { qty: row.qty, version: Number(row.version) };
}

/** Set an absolute quantity (seed / admin restock), still through changeStock so I-1 holds. */
export async function setStock(
  tx: Tx,
  args: { productId: number; city: string; qty: number; reason: StockReason },
): Promise<{ qty: number; version: number }> {
  // Ensure the row exists (seed), then lock it to compute the delta safely.
  await tx.query(
    `INSERT INTO inventory (product_id, city_code, qty) VALUES ($1, $2, 0)
     ON CONFLICT (product_id, city_code) DO NOTHING`,
    [args.productId, args.city],
  );
  const cur = await tx.query<{ qty: number }>(
    'SELECT qty FROM inventory WHERE product_id = $1 AND city_code = $2 FOR UPDATE',
    [args.productId, args.city],
  );
  const delta = args.qty - (cur.rows[0]?.qty ?? 0);
  const res = await changeStock(tx, { productId: args.productId, city: args.city, delta, reason: args.reason });
  if (!res) throw new Error('setStock: unexpected negative stock');
  return res;
}

/** Insert an outbox row in the caller's transaction (doc/03 §4.2) and wake the relay on commit. */
export async function enqueue(tx: Tx, topic: string, key: string, eventType: string, payload: unknown): Promise<void> {
  await tx.query(
    `WITH ev AS (INSERT INTO outbox (topic, msg_key, event_type, payload) VALUES ($1, $2, $3, $4) RETURNING id)
     SELECT pg_notify($5::text, '') FROM ev`,
    [topic, key, eventType, JSON.stringify(payload), OUTBOX_CHANNEL],
  );
}
