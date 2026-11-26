import { env } from '../config.js';
import { getPool } from '../lib/db.js';
import { getKafka, topics } from '../lib/kafka.js';
import { log, errMsg, maskEmail } from '../lib/log.js';
import { sleep } from '../lib/stats.js';
import type { Envelope, InventoryChanged, OrderPlaced } from '../lib/events.js';
import { notifyBackInStock } from '../domain/alerts.js';

/**
 * Notifier (doc/03 §4.4): the brief's "sends a confirmation to customer", plus low-stock alerts
 * for store ops, and back-in-stock alerts for shoppers (doc/17). Email is SIMULATED (a row + a log
 * line). Idempotent via UNIQUE(event_id) / alerts that can only be notified once.
 */
export const NOTIFIER_GROUP = 'notifier';

const FK_VIOLATION = '23503';

async function onOrderPlaced(eventId: number, o: OrderPlaced) {
  const body = `Hi ${o.customer.name}, your StockHop order ${o.orderNumber} is confirmed.`;
  const res = await getPool().query(
    `INSERT INTO notifications (event_id, order_id, channel, recipient, body)
     VALUES ($1, $2, 'email', $3, $4) ON CONFLICT (event_id) DO NOTHING`,
    [eventId, o.orderId, o.customer.email, body],
  );
  if (res.rowCount) log.info('notifier: 📧 confirmation sent', { order: o.orderNumber, to: maskEmail(o.customer.email) });
}

async function onInventoryChanged(eventId: number, e: InventoryChanged) {
  // Back on the shelf (restock, released payment hold…): tell shoppers waiting for it (doc/17).
  await notifyBackInStock(eventId, e);
  if (e.reason !== 'order' || e.qty > env.LOW_STOCK_THRESHOLD) return;
  const res = await getPool().query(
    `INSERT INTO stock_alerts (event_id, product_id, city_code, qty)
     VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING`,
    [eventId, e.productId, e.cityCode, e.qty],
  );
  if (res.rowCount) log.info('notifier: ⚠ low stock', { sku: e.doc.sku, city: e.cityCode, qty: e.qty });
}

export async function runNotifier(signal: AbortSignal): Promise<void> {
  const t = topics();
  const consumer = getKafka().consumer({ groupId: NOTIFIER_GROUP });
  await consumer.connect();
  await consumer.subscribe({ topics: [t.orders, t.inventory], fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, message, heartbeat }) => {
      if (!message.value) return;
      const envl = JSON.parse(message.value.toString()) as Envelope<unknown>;
      for (let wait = 1000; !signal.aborted; wait = Math.min(wait * 2, 10_000)) {
        try {
          if (topic === t.orders) await onOrderPlaced(envl.eventId, envl.payload as OrderPlaced);
          else await onInventoryChanged(envl.eventId, envl.payload as InventoryChanged);
          return;
        } catch (e) {
          // An event that refers to rows wiped by a demo reset can never succeed: skip it.
          if ((e as { code?: string }).code === FK_VIOLATION) {
            log.warn('notifier: skipping event for missing rows (demo reset?)', { eventId: envl.eventId });
            return;
          }
          log.warn('notifier: failed, retrying', { eventId: envl.eventId, err: errMsg(e) });
          await heartbeat();
          await sleep(wait);
        }
      }
    },
  });
  log.info('notifier: started');

  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  await consumer.disconnect().catch(() => {});
  log.info('notifier: stopped');
}
