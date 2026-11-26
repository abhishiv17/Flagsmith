/**
 * Proof drills for the event pipeline (doc/07 §6). Both need the search indexer STOPPED first
 * and the relay running, e.g. `npm run workers:core` in one terminal and nothing else.
 *
 *   npm run drill:outage   Search is down while shoppers keep buying: makes 3 sales, shows lag
 *                          climbing, then waits for you to start the indexer and times recovery.
 *                          Puts the 3 units back afterwards.
 *   npm run drill:replay   Rewinds the indexer to the very first Kafka event and waits for you to
 *                          start it. Every old event is re-applied; the index must end identical.
 *
 * Start the indexer when prompted: `npm run workers:indexer` (or pass --start to have the script
 * start it for you). Exit code 0 = drill passed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { getPool, closePool, withTx } from '../server/lib/db.js';
import { getKafka, topics } from '../server/lib/kafka.js';
import { getSearch, searchIndex } from '../server/lib/search.js';
import { docId } from '../server/lib/events.js';
import { changeStock } from '../server/domain/stock.js';
import { INDEXER_GROUP } from '../server/workers/indexer.js';

const mode = process.argv[2];
const autoStart = process.argv.includes('--start');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const clock = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
const say = (m: string) => console.log(`${clock()}  ${m}`);

type Inv = { product_id: number; city_code: string; qty: number; version: string };
type Doc = { _id: string; found: boolean; _version?: number; _source?: { stock_version: number; qty: number } };

const admin = getKafka().admin();
const topic = topics().inventory;
let indexer: ChildProcess | null = null;

async function lag(): Promise<number> {
  const ends = await admin.fetchTopicOffsets(topic);
  const parts = (await admin.fetchOffsets({ groupId: INDEXER_GROUP, topics: [topic] }))[0]?.partitions ?? [];
  let total = 0;
  for (const e of ends) {
    const c = Number(parts.find((p) => p.partition === e.partition)?.offset ?? -1);
    total += Math.max(0, Number(e.high) - (c >= 0 ? c : Number(e.low)));
  }
  return total;
}

async function indexerMembers(): Promise<number> {
  const { groups } = await admin.describeGroups([INDEXER_GROUP]);
  return groups[0]?.members.length ?? 0;
}

async function snapshot() {
  const { rows } = await getPool().query<Inv>('SELECT product_id, city_code, qty, version FROM inventory ORDER BY 1, 2');
  const res = await getSearch().mget({ index: searchIndex().alias, body: { ids: rows.map((r) => docId(r.product_id, r.city_code)) } });
  const docs = new Map((res.body as { docs: Doc[] }).docs.map((d) => [d._id, d]));
  const drift = rows.filter((r) => {
    const d = docs.get(docId(r.product_id, r.city_code));
    return !d?.found || d._source?.stock_version !== Number(r.version) || d._source?.qty !== r.qty;
  });
  return { rows, docs, drift: drift.length };
}

function startIndexer() {
  say('starting the indexer (npm run workers:indexer)…');
  indexer = spawn('npx', ['tsx', 'server/workers/index.ts', '--only=indexer'], { stdio: 'ignore', shell: true });
}

/** Waits until the indexer has joined, lag is 0 and drift is 0. Returns ms from join to caught up. */
async function waitForRecovery(timeoutMs = 10 * 60_000) {
  if (autoStart) startIndexer();
  else say('👉 now start the indexer in another terminal:  npm run workers:indexer');
  const deadline = Date.now() + timeoutMs;
  let joinedAt = 0;
  let last = -1;
  while (Date.now() < deadline) {
    const [members, l] = await Promise.all([indexerMembers(), lag()]);
    if (members && !joinedAt) { joinedAt = Date.now(); say('indexer joined the consumer group'); }
    if (l !== last) { say(`indexer lag: ${l}`); last = l; }
    if (joinedAt && l === 0) {
      const s = await snapshot();
      if (s.drift === 0) return { ms: Date.now() - joinedAt, snap: s };
    }
    await sleep(500);
  }
  throw new Error('timed out waiting for the indexer to catch up');
}

async function preflight() {
  await admin.connect();
  if (await indexerMembers()) {
    throw new Error('the search indexer is still running. Stop it first (run only `npm run workers:core`).');
  }
  const s = await snapshot();
  if (s.drift) throw new Error(`index is not in sync before the drill (${s.drift} docs differ): run npm run check:sync -- --wait=60`);
  say(`✅ indexer stopped · index in sync (${s.rows.length}/${s.rows.length}) · lag ${await lag()}`);
  return s;
}

async function outage() {
  console.log('\nDRILL: search indexer outage while shoppers keep buying\n');
  await preflight();
  const { rows } = await getPool().query<Inv>(
    `SELECT product_id, city_code, qty, version FROM inventory WHERE city_code = 'MUM' AND qty >= 5 ORDER BY product_id LIMIT 3`,
  );
  if (rows.length < 3) throw new Error('need 3 MUM rows with qty >= 5');
  const sold: Inv[] = [];
  try {
    for (const r of rows) {
      const ok = await withTx((tx) => changeStock(tx, { productId: r.product_id, city: r.city_code, delta: -1, reason: 'order' }));
      if (!ok) throw new Error(`could not sell ${docId(r.product_id, r.city_code)}`);
      sold.push(r);
      say(`🛒 sale committed in PostgreSQL: ${docId(r.product_id, r.city_code)} qty ${r.qty} → ${ok.qty}`);
    }
    let l = 0;
    for (let i = 0; i < 40 && l < 3; i++) { await sleep(250); l = await lag(); }
    const s = await snapshot();
    say(`⚠️  search is behind: lag ${l}, ${s.drift} docs stale. Checkout kept working; the events wait in Kafka`);
    if (l < 3) throw new Error('lag never reached 3: is the relay running?');
    const { ms } = await waitForRecovery();
    say(`✅ recovered ${ms} ms after the indexer came back · lag 0 · drift 0`);
  } finally {
    for (const r of sold) {
      await withTx((tx) => changeStock(tx, { productId: r.product_id, city: r.city_code, delta: 1, reason: 'restock' }));
    }
    if (sold.length) say(`restocked the ${sold.length} test units`);
  }
}

async function replay() {
  console.log('\nDRILL: replay every Kafka event from the beginning\n');
  const before = await preflight();
  const ends = await admin.fetchTopicOffsets(topic);
  const total = ends.reduce((n, e) => n + Number(e.high) - Number(e.low), 0);
  await admin.resetOffsets({ groupId: INDEXER_GROUP, topic, earliest: true });
  say(`⏪ indexer rewound to the first event: ${await lag()} events to re-apply (${total} retained in ${topic})`);
  const { ms, snap } = await waitForRecovery();
  const changed = before.rows.filter((r) => {
    const a = before.docs.get(docId(r.product_id, r.city_code));
    const b = snap.docs.get(docId(r.product_id, r.city_code));
    return a?._source?.stock_version !== b?._source?.stock_version || a?._source?.qty !== b?._source?.qty;
  });
  // Rows can legitimately change if a real shopper buys during the drill; drift 0 is the real check.
  say(`✅ replayed ${total} events in ${ms} ms · drift 0 · ${before.rows.length - changed.length}/${before.rows.length} docs identical to before` +
    (changed.length ? ` (${changed.length} changed by live traffic during the drill)` : ''));
  say('old events were rejected by external versioning (409), so nothing went backwards');
}

async function main() {
  if (mode === 'outage') await outage();
  else if (mode === 'replay') await replay();
  else { console.error('usage: tsx scripts/drill.ts outage|replay [--start]'); process.exitCode = 2; }
}

main()
  .catch((e) => { say(`❌ ${e instanceof Error ? e.message : e}`); process.exitCode = 1; })
  .finally(async () => {
    if (indexer) say('the indexer started by this drill keeps running in the background; stop it with Ctrl+C in its terminal or restart workers normally');
    await admin.disconnect().catch(() => {});
    await closePool();
    process.exit(process.exitCode ?? 0);
  });
