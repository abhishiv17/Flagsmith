import { Router, type Request } from 'express';
import { cacheHealth } from '../lib/cache.js';
import { z } from 'zod';
import { env } from '../config.js';
import { getPool, withTx } from '../lib/db.js';
import { getSearch } from '../lib/search.js';
import { HttpError, CityCode, parse } from '../lib/http.js';
import { indexDrift } from '../lib/drift.js';
import { maskEmail } from '../lib/log.js';
import { setStock } from '../domain/stock.js';

/** /ops pipeline view (doc/05) + admin restock for demo resets. Never touches Kafka directly. */
export const ops = Router();

const WORKERS = ['relay', 'indexer', 'notifier', 'monitor', 'analytics', 'clickhouse'] as const;
const STALE_MS = 6000;

ops.get('/ops/summary', async (_req, res) => {
  const pool = getPool();
  const [pg, os, stats, outbox, events, notes, alerts, orders, drift] = await Promise.allSettled([
    pool.query('SELECT 1'),
    getSearch().cluster.health(),
    pool.query<{ key: string; value: Record<string, unknown>; age_ms: string }>(
      `SELECT key, value, (extract(epoch FROM now() - updated_at) * 1000)::bigint AS age_ms FROM pipeline_stats`,
    ),
    pool.query<{ pending: string; last_published: string | null }>(
      `SELECT count(*) FILTER (WHERE published_at IS NULL) AS pending,
              max(id) FILTER (WHERE published_at IS NOT NULL) AS last_published
         FROM outbox`,
    ),
    pool.query<{ id: string; event_type: string; msg_key: string; payload: Record<string, unknown>; created_at: Date; published_at: Date | null }>(
      'SELECT id, event_type, msg_key, payload, created_at, published_at FROM outbox ORDER BY id DESC LIMIT 15',
    ),
    pool.query<{ recipient: string; body: string; created_at: Date }>(
      'SELECT recipient, body, created_at FROM notifications ORDER BY id DESC LIMIT 5',
    ),
    pool.query<{ name: string; city_code: string; qty: number; created_at: Date }>(
      `SELECT p.name, a.city_code, a.qty, a.created_at FROM stock_alerts a JOIN products p ON p.id = a.product_id
        ORDER BY a.id DESC LIMIT 5`,
    ),
    pool.query<{ total: string; last_minute: string }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE created_at > now() - interval '1 minute') AS last_minute FROM orders`,
    ),
    indexDrift(),
  ]);

  const statRows = stats.status === 'fulfilled' ? stats.value.rows : [];
  const beat = new Map(statRows.filter((r) => r.key.startsWith('heartbeat:')).map((r) => [r.key.slice(10), Number(r.age_ms)]));
  const monitorUp = (beat.get('monitor') ?? Infinity) < STALE_MS;

  res.set('Cache-Control', 'no-store');
  res.json({
    services: {
      postgres: pg.status === 'fulfilled' ? 'up' : 'down',
      opensearch: os.status === 'fulfilled' ? 'up' : 'down',
      valkey: await cacheHealth(),
    },
    workers: WORKERS.map((name) => {
      const age = beat.get(name);
      return { name, up: age !== undefined && age < STALE_MS, lastSeenMs: age ?? null };
    }),
    outbox:
      outbox.status === 'fulfilled'
        ? { pending: Number(outbox.value.rows[0]?.pending ?? 0), lastPublishedId: Number(outbox.value.rows[0]?.last_published ?? 0) }
        : null,
    consumers: statRows
      .filter((r) => r.key.startsWith('lag:'))
      .map((r) => ({ group: r.value.group, topic: r.value.topic, lag: r.value.lag, stale: !monitorUp }))
      .sort((a, b) => `${a.group}${a.topic}`.localeCompare(`${b.group}${b.topic}`)),
    index: drift.status === 'fulfilled' ? drift.value : null,
    recentEvents:
      events.status === 'fulfilled'
        ? events.value.rows.map((e) => ({
            id: Number(e.id), type: e.event_type, key: e.msg_key,
            summary: summarize(e.event_type, e.payload),
            createdAt: e.created_at, publishedAt: e.published_at,
          }))
        : [],
    recentNotifications:
      notes.status === 'fulfilled' ? notes.value.rows.map((n) => ({ to: maskEmail(n.recipient), body: n.body, at: n.created_at })) : [],
    stockAlerts:
      alerts.status === 'fulfilled' ? alerts.value.rows.map((a) => ({ product: a.name, city: a.city_code, qty: a.qty, at: a.created_at })) : [],
    orders:
      orders.status === 'fulfilled'
        ? { total: Number(orders.value.rows[0]?.total ?? 0), lastMinute: Number(orders.value.rows[0]?.last_minute ?? 0) }
        : null,
  });
});

function summarize(type: string, p: Record<string, unknown>): string {
  if (type === 'OrderPlaced') return `${p.orderNumber} · ₹${Math.round(Number(p.totalPaise) / 100)}`;
  const doc = p.doc as { name?: string } | undefined;
  return `${doc?.name ?? 'product'} · ${p.cityCode} · qty ${p.qty} (${Number(p.delta) >= 0 ? '+' : ''}${p.delta}) · v${p.version} · ${p.reason}`;
}

function requireAdmin(req: Request) {
  if (!env.ADMIN_TOKEN || req.get('x-admin-token') !== env.ADMIN_TOKEN) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Admin token required');
  }
}

/** Demo reset helper: set absolute stock THROUGH the outbox (I-1 holds even for resets). */
ops.post('/admin/restock', async (req, res) => {
  requireAdmin(req);
  const b = parse(z.object({ sku: z.string().max(20), city: CityCode, qty: z.number().int().min(0).max(1000) }), req.body);
  const result = await withTx(async (tx) => {
    const p = await tx.query<{ id: number }>('SELECT id FROM products WHERE sku = $1', [b.sku]);
    const productId = p.rows[0]?.id;
    if (!productId) throw new HttpError(404, 'NOT_FOUND', `Unknown SKU ${b.sku}`);
    return setStock(tx, { productId, city: b.city, qty: b.qty, reason: 'restock' });
  });
  res.json({ sku: b.sku, city: b.city, ...result });
});
