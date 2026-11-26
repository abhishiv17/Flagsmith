import { analyticsConfig } from '../config.js';
import { getKafka, topics } from '../lib/kafka.js';
import { getSearch } from '../lib/search.js';
import { log, errMsg } from '../lib/log.js';
import { sleep } from '../lib/stats.js';
import type { Envelope, InventoryChanged, OrderPlaced } from '../lib/events.js';
import type { ActivityEvent } from '../domain/activity.js';

/**
 * Analytics consumer (doc/14): reads shopper activity, orders and stock changes from Kafka and
 * writes one OpenSearch document per event into the activity index, for /ops and OpenSearch
 * Dashboards. Document _id = outbox event id, so redelivered or replayed events overwrite
 * themselves instead of double-counting.
 */
export const ANALYTICS_GROUP = 'analytics';

export const ACTIVITY_MAPPING = {
  settings: { number_of_shards: 1, number_of_replicas: 0 },
  mappings: {
    dynamic: 'strict',
    properties: {
      event_id: { type: 'long' },
      type: { type: 'keyword' },
      at: { type: 'date' },
      visitor: { type: 'keyword' },
      path: { type: 'keyword' },
      page: { type: 'keyword' },
      city: { type: 'keyword' },
      label: { type: 'keyword' },
      product_id: { type: 'integer' },
      q: { type: 'keyword' },
      results: { type: 'integer' },
      code: { type: 'keyword' },
      order_number: { type: 'keyword' },
      total_paise: { type: 'long' },
      items: { type: 'integer' },
      qty: { type: 'integer' },
      delta: { type: 'integer' },
      reason: { type: 'keyword' },
      sold_out: { type: 'boolean' },
    },
  },
} as const;

/** "/p/12?x" → "/p/:id", so page views group by screen. */
export const pageOf = (path: string) => (path.split('?')[0] ?? '/').replace(/\/(p|orders)\/[^/]+/, '/$1/:id') || '/';

type Doc = Record<string, unknown>;

export function toActivityDoc(topic: string, env: Envelope<unknown>): Doc | null {
  const t = topics();
  const base = { event_id: env.eventId, at: env.occurredAt };
  if (topic === t.activity) {
    const e = env.payload as ActivityEvent & { visitor: string; at: string };
    const m = /^\/p\/(\d+)/.exec(e.path);
    return {
      ...base, at: e.at, type: e.type, visitor: e.visitor, path: e.path, page: pageOf(e.path), city: e.city,
      label: e.label, product_id: e.productId ?? (m ? Number(m[1]) : undefined), q: e.q?.toLowerCase(),
      results: e.results, code: e.code,
    };
  }
  if (topic === t.orders) {
    const o = env.payload as OrderPlaced;
    // No customer name or email in analytics.
    return { ...base, type: 'order_placed', city: o.cityCode, order_number: o.orderNumber, total_paise: o.totalPaise,
      items: o.items.reduce((n, i) => n + i.qty, 0) };
  }
  if (topic === t.inventory) {
    const s = env.payload as InventoryChanged;
    return { ...base, type: 'stock_changed', city: s.cityCode, product_id: s.productId, qty: s.qty, delta: s.delta,
      reason: s.reason, sold_out: s.qty === 0 && s.delta < 0 };
  }
  return null;
}

export async function ensureActivityIndex(): Promise<void> {
  const { index } = analyticsConfig();
  const os = getSearch();
  const exists = await os.indices.exists({ index });
  if (!exists.body) {
    await os.indices.create({ index, body: ACTIVITY_MAPPING as unknown as Record<string, unknown> });
    log.info('analytics: created index', { index });
  }
}

export async function runAnalytics(signal: AbortSignal): Promise<void> {
  const { index } = analyticsConfig();
  const t = topics();
  await ensureActivityIndex();
  const consumer = getKafka().consumer({ groupId: ANALYTICS_GROUP });
  await consumer.connect();
  await consumer.subscribe({ topics: [t.activity, t.orders, t.inventory], fromBeginning: true });

  await consumer.run({
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, isRunning, isStale }) => {
      const msgs = batch.messages.filter((m) => m.value);
      if (!msgs.length) return;
      const docs = msgs
        .map((m) => toActivityDoc(batch.topic, JSON.parse(m.value!.toString()) as Envelope<unknown>))
        .filter((d): d is Doc => d !== null);
      const body = docs.flatMap((d) => [{ index: { _index: index, _id: String(d.event_id) } }, d]);
      for (let attempt = 0, wait = 1000; !signal.aborted && isRunning() && !isStale(); attempt++, wait = Math.min(wait * 2, 10_000)) {
        try {
          if (body.length) {
            const r = await getSearch().bulk({ body });
            const items = (r.body as { items: { index?: { status: number; error?: unknown } }[] }).items;
            const bad = items.filter((i) => (i.index?.status ?? 500) >= 300);
            if (bad.length) throw new Error(`bulk: ${bad.length} failed, first ${JSON.stringify(bad[0]?.index?.error)}`);
          }
          log.info('analytics: indexed', { topic: batch.topic, docs: docs.length });
          resolveOffset(batch.messages[batch.messages.length - 1]!.offset);
          await commitOffsetsIfNecessary();
          await heartbeat();
          return;
        } catch (e) {
          log.warn('analytics: bulk failed, retrying', { topic: batch.topic, attempt, err: errMsg(e) });
          await heartbeat();
          await sleep(wait);
        }
      }
    },
  });
  log.info('analytics: started');
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  await consumer.disconnect().catch(() => {});
  log.info('analytics: stopped');
}
