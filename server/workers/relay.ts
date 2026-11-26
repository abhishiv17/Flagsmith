import type { Producer } from 'kafkajs';
import type { PoolClient } from 'pg';
import { withTx, getPool } from '../lib/db.js';
import { createProducer } from '../lib/kafka.js';
import { log, errMsg } from '../lib/log.js';
import { sleep } from '../lib/stats.js';
import type { Envelope, EventTypeName } from '../lib/events.js';
import { OUTBOX_CHANNEL } from '../domain/stock.js';

/**
 * Outbox relay (doc/03 §4.2). Run EXACTLY ONE instance: a single relay reading in id order keeps
 * per-key ordering. Crash after send but before commit → duplicates, which consumers absorb (I-6).
 */
const BATCH = 100;
/** Safety-net poll interval; normally the relay is woken by NOTIFY within milliseconds of a commit. */
const IDLE_MS = 1000;

type Row = { id: string; topic: string; msg_key: string; event_type: EventTypeName; payload: unknown; created_at: Date };

export async function publishBatch(producer: Producer): Promise<number> {
  return withTx(async (tx) => {
    const { rows } = await tx.query<Row>(
      `SELECT id, topic, msg_key, event_type, payload, created_at
         FROM outbox WHERE published_at IS NULL
        ORDER BY id LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [BATCH],
    );
    if (rows.length === 0) return 0;

    // Group by topic, preserving id order within each topic (same key → same partition → ordered).
    const byTopic = new Map<string, { key: string; value: string; headers: Record<string, string> }[]>();
    for (const r of rows) {
      const envelope: Envelope<unknown> = {
        eventId: Number(r.id),
        eventType: r.event_type,
        schemaVersion: 1,
        occurredAt: r.created_at.toISOString(),
        payload: r.payload,
      };
      const list = byTopic.get(r.topic) ?? [];
      list.push({
        key: r.msg_key,
        value: JSON.stringify(envelope),
        headers: { 'event-type': r.event_type, 'event-id': r.id },
      });
      byTopic.set(r.topic, list);
    }

    await producer.sendBatch({
      acks: -1,
      topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })),
    });
    await tx.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
    return rows.length;
  });
}

/** Arbitrary constant key for the "only one relay" advisory lock. */
const RELAY_LOCK_KEY = 4_242_001;

/**
 * Blocks until this process holds the relay lock. A second relay (e.g. a teammate's laptop)
 * waits in standby instead of publishing, preserving per-key ordering (doc/03 §4.2).
 * The lock is session-scoped: it's released automatically if this process dies.
 */
async function acquireRelayLock(signal: AbortSignal): Promise<PoolClient | null> {
  const client = await getPool().connect();
  let warned = false;
  while (!signal.aborted) {
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [RELAY_LOCK_KEY]);
    if (rows[0]?.ok) return client;
    if (!warned) {
      log.warn('relay: another relay holds the lock, standing by');
      warned = true;
    }
    await sleep(5000);
  }
  client.release();
  return null;
}

export async function runRelay(signal: AbortSignal): Promise<void> {
  const lock = await acquireRelayLock(signal);
  if (!lock) return;
  const producer = await createProducer();

  // doc/12 F3: wake as soon as a transaction that wrote the outbox commits (pg_notify in changeStock /
  // enqueue / checkout) instead of polling every 200 ms. The lock connection is a dedicated session in
  // autocommit mode, so it can LISTEN. IDLE_MS remains as a safety-net poll in case a notification is lost.
  let wake: (() => void) | null = null;
  let notified = false;
  lock.on('notification', () => {
    notified = true;
    wake?.();
  });
  await lock.query(`LISTEN ${OUTBOX_CHANNEL}`);
  const waitForWork = () =>
    new Promise<void>((resolve) => {
      if (notified || signal.aborted) return resolve();
      const done = () => { clearTimeout(timer); wake = null; resolve(); };
      const timer = setTimeout(done, IDLE_MS);
      wake = done;
    });

  log.info('relay: started (holds relay lock, listening for outbox commits)');
  try {
    while (!signal.aborted) {
      try {
        notified = false;
        const n = await publishBatch(producer);
        if (n > 0) log.info('relay: published', { count: n });
        else await waitForWork();
      } catch (e) {
        // Kafka or PG unavailable: rows stay unpublished and are retried. Checkout is unaffected.
        log.warn('relay: publish failed, retrying', { err: errMsg(e) });
        await sleep(2000);
      }
    }
  } finally {
    await producer.disconnect().catch(() => {});
    await lock.query(`UNLISTEN ${OUTBOX_CHANNEL}`).catch(() => {});
    await lock.query('SELECT pg_advisory_unlock($1)', [RELAY_LOCK_KEY]).catch(() => {});
    lock.release();
    log.info('relay: stopped');
  }
}
