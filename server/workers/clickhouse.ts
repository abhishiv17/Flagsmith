import { getKafka, topics } from '../lib/kafka.js';
import { clickhouseConfig } from '../config.js';
import { chEnabled, chInsert, ensureSchema } from '../lib/clickhouse.js';
import { log, errMsg } from '../lib/log.js';
import { sleep } from '../lib/stats.js';
import type { Envelope, OrderPlaced } from '../lib/events.js';
import type { ActivityEvent } from '../domain/activity.js';
import { pageOf } from './analytics.js';

/**
 * ClickHouse sink (doc/16): orders.placed and user.activity from Kafka into Aiven for ClickHouse,
 * for the retailer's customer dashboard ("who buys most, who browses most, who gets a coupon").
 *
 * Own consumer group, so it reads the same events as the indexer, notifier and analytics workers
 * without affecting them, and starts from the beginning of each topic (history backfills itself).
 * Tables are ReplacingMergeTree keyed by order id / event id, so redelivery never double-counts.
 * If ClickHouse isn't configured the worker idles instead of crashing the worker host.
 */
export const CLICKHOUSE_GROUP = 'clickhouse';

type OrderEvent = OrderPlaced & { visitor?: string; discountPaise?: number; couponCode?: string | null };
type ActivityPayload = ActivityEvent & { visitor: string; at: string };

const ts = (v: string | number) => new Date(v).toISOString().replace('T', ' ').replace('Z', '');

function toRows(topic: string, env: Envelope<unknown>) {
  const t = topics();
  if (topic === t.orders) {
    const o = env.payload as OrderEvent;
    const at = ts(env.occurredAt);
    const email = (o.customer?.email ?? '').toLowerCase();
    return {
      orders: [{
        order_id: o.orderId, at, order_number: o.orderNumber, city: o.cityCode,
        customer_email: email, customer_name: o.customer?.name ?? '', visitor: o.visitor ?? '',
        total_paise: o.totalPaise, discount_paise: o.discountPaise ?? 0, coupon: o.couponCode ?? '',
        items: o.items.reduce((n, i) => n + i.qty, 0), source: 'live',
      }],
      lines: o.items.map((i) => ({
        order_id: o.orderId, product_id: i.productId, at, city: o.cityCode, customer_email: email,
        name: i.name, qty: i.qty, unit_price_paise: i.unitPricePaise, seller: (i as { seller?: string }).seller ?? '',
        seller_id: (i as { sellerId?: number }).sellerId ?? 0, source: 'live',
      })),
      activity: [],
    };
  }
  if (topic === t.activity) {
    const e = env.payload as ActivityPayload;
    const m = /^\/p\/(\d+)/.exec(e.path ?? '');
    return {
      orders: [], lines: [],
      activity: [{
        event_id: env.eventId, at: ts(e.at ?? env.occurredAt), type: e.type, visitor: e.visitor ?? '',
        city: e.city ?? '', page: pageOf(e.path ?? '/'), label: e.label ?? '',
        product_id: e.productId ?? (m ? Number(m[1]) : 0), q: (e.q ?? '').toLowerCase(), source: 'live',
      }],
    };
  }
  return { orders: [], lines: [], activity: [] };
}

export async function runClickhouse(signal: AbortSignal): Promise<void> {
  if (!chEnabled()) {
    log.warn('clickhouse: CLICKHOUSE_URL not set, sink idle');
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    return;
  }
  const cfg = clickhouseConfig()!;
  log.info('clickhouse: target', { host: cfg.url.hostname, port: cfg.url.port, database: cfg.database }); // never the password
  for (let wait = 1000; !signal.aborted; wait = Math.min(wait * 2, 30_000)) {
    try {
      await ensureSchema();
      break;
    } catch (e) {
      log.warn('clickhouse: schema not ready, retrying', { err: errMsg(e) });
      await sleep(wait);
    }
  }
  const t = topics();
  const consumer = getKafka().consumer({ groupId: CLICKHOUSE_GROUP });
  await consumer.connect();
  await consumer.subscribe({ topics: [t.orders, t.activity], fromBeginning: true });

  await consumer.run({
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, isRunning, isStale }) => {
      const msgs = batch.messages.filter((m) => m.value);
      if (!msgs.length) return;
      const rows = { orders: [] as Record<string, unknown>[], lines: [] as Record<string, unknown>[], activity: [] as Record<string, unknown>[] };
      for (const m of msgs) {
        try {
          const r = toRows(batch.topic, JSON.parse(m.value!.toString()) as Envelope<unknown>);
          rows.orders.push(...r.orders);
          rows.lines.push(...r.lines);
          rows.activity.push(...r.activity);
        } catch (e) {
          log.warn('clickhouse: skipped malformed event', { topic: batch.topic, offset: m.offset, err: errMsg(e) });
        }
      }
      for (let attempt = 0, wait = 1000; !signal.aborted && isRunning() && !isStale(); attempt++, wait = Math.min(wait * 2, 15_000)) {
        try {
          await chInsert('orders', rows.orders);
          await chInsert('order_lines', rows.lines);
          await chInsert('activity', rows.activity);
          log.info('clickhouse: inserted', { topic: batch.topic, orders: rows.orders.length, lines: rows.lines.length, activity: rows.activity.length });
          resolveOffset(batch.messages[batch.messages.length - 1]!.offset);
          await commitOffsetsIfNecessary();
          await heartbeat();
          return;
        } catch (e) {
          log.warn('clickhouse: insert failed, retrying', { topic: batch.topic, attempt, err: errMsg(e) });
          await heartbeat();
          await sleep(wait);
        }
      }
    },
  });
  log.info('clickhouse: started');
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  await consumer.disconnect().catch(() => {});
  log.info('clickhouse: stopped');
}
