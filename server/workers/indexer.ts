import { getKafka, topics } from '../lib/kafka.js';
import { getSearch, searchIndex } from '../lib/search.js';
import { log, errMsg } from '../lib/log.js';
import { sleep } from '../lib/stats.js';
import { docId, toSearchDoc, type Envelope, type InventoryChanged } from '../lib/events.js';
import { cacheStock, getCache } from '../lib/cache.js';

/**
 * Search indexer (doc/03 §4.3): inventory.changed → OpenSearch, guarded by external versioning.
 * Older/equal versions are rejected by OpenSearch (409) and treated as success, so replays and
 * duplicates are harmless (I-5, I-6). It NEVER writes to PostgreSQL inventory (I-2).
 *
 * Batched (doc/12 F3): each Kafka fetch is applied as ONE OpenSearch _bulk request instead of one
 * round trip per event, and both partitions are processed in parallel. Within a batch only the newest
 * version of each document is sent: events carry the full document (ADR-4) and OpenSearch would reject
 * the older ones as stale anyway, so the result is identical.
 */
export const INDEXER_GROUP = 'search-indexer';

const isVersionConflict = (err: unknown) => (err as { meta?: { statusCode?: number } }).meta?.statusCode === 409;

/** Index one event (kept for scripts/tests). */
export async function applyInventoryEvent(e: InventoryChanged): Promise<'indexed' | 'stale'> {
  try {
    await getSearch().index({
      index: searchIndex().alias,
      id: docId(e.productId, e.cityCode),
      version: e.version,
      version_type: 'external',
      body: toSearchDoc(e),
    });
    return 'indexed';
  } catch (err) {
    if (isVersionConflict(err)) return 'stale';
    throw err;
  }
}

/** Index many events in one _bulk call. 409s are stale (fine); any other item failure throws so the batch is retried. */
export async function applyInventoryEvents(events: InventoryChanged[]): Promise<{ indexed: number; stale: number }> {
  if (!events.length) return { indexed: 0, stale: 0 };
  const alias = searchIndex().alias;
  const body = events.flatMap((e) => [
    { index: { _index: alias, _id: docId(e.productId, e.cityCode), version: e.version, version_type: 'external' } },
    toSearchDoc(e),
  ]);
  const res = await getSearch().bulk({ body });
  const items = (res.body as unknown as { items: { index?: { status: number; error?: { type?: string; reason?: string } } }[] }).items;
  let indexed = 0; let stale = 0;
  const failures: string[] = [];
  for (const it of items) {
    const status = it.index?.status ?? 0;
    if (status >= 200 && status < 300) indexed++;
    else if (status === 409) stale++;
    else failures.push(`${status} ${it.index?.error?.type ?? ''} ${it.index?.error?.reason ?? ''}`.trim());
  }
  if (failures.length) throw new Error(`bulk: ${failures.length} item(s) failed: ${failures.slice(0, 3).join('; ')}`);
  return { indexed, stale };
}

/** Newest event per document within a batch (versions are global and strictly increasing per key). */
function latestPerDoc(events: Envelope<InventoryChanged>[]): InventoryChanged[] {
  const latest = new Map<string, InventoryChanged>();
  for (const { payload: e } of events) {
    const id = docId(e.productId, e.cityCode);
    const cur = latest.get(id);
    if (!cur || e.version > cur.version) latest.set(id, e);
  }
  return [...latest.values()];
}

export async function runIndexer(signal: AbortSignal): Promise<void> {
  getCache(); // start the Valkey connection now, so the first (catch-up) batch can write through
  const consumer = getKafka().consumer({ groupId: INDEXER_GROUP });
  await consumer.connect();
  await consumer.subscribe({ topic: topics().inventory, fromBeginning: true });

  await consumer.run({
    partitionsConsumedConcurrently: 2,
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, isRunning, isStale }) => {
      const msgs = batch.messages;
      if (!msgs.length) return;
      const events = msgs
        .filter((m) => m.value)
        .map((m) => JSON.parse(m.value!.toString()) as Envelope<InventoryChanged>);
      const docs = latestPerDoc(events);
      // Retry until OpenSearch accepts the batch; offsets aren't committed meanwhile, so lag grows
      // visibly on /ops and drains when OpenSearch recovers.
      for (let attempt = 0, wait = 1000; !signal.aborted && isRunning() && !isStale(); attempt++, wait = Math.min(wait * 2, 10_000)) {
        try {
          const r = await applyInventoryEvents(docs);
          // Write-through to the Valkey live-stock cache (version-guarded; never fails the batch).
          await cacheStock(docs.map((e) => ({ productId: e.productId, city: e.cityCode, cityName: e.doc.cityName, qty: e.qty, version: e.version })));
          log.info('indexer: applied batch', {
            partition: batch.partition, events: events.length, docs: docs.length, indexed: r.indexed, stale: r.stale,
            lastEventId: events[events.length - 1]?.eventId,
          });
          resolveOffset(msgs[msgs.length - 1]!.offset);
          await commitOffsetsIfNecessary();
          await heartbeat();
          return;
        } catch (e) {
          log.warn('indexer: OpenSearch bulk failed, retrying', { partition: batch.partition, attempt, err: errMsg(e) });
          await heartbeat();
          await sleep(wait);
        }
      }
    },
  });
  log.info('indexer: started');

  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  await consumer.disconnect().catch(() => {});
  log.info('indexer: stopped');
}
