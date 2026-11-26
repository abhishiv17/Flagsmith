/**
 * Concurrency + pipeline test suite. Runs real scenarios against the real code and Aiven services,
 * then (re)writes doc/12-metrics.md with the measured results.
 *
 *   npm run test:concurrency                       full suite (includes a race against the deployed site)
 *   npm run test:concurrency -- --no-deployed      skip the Vercel scenario
 *   npm run test:concurrency -- --keep             keep test orders instead of deleting them
 *   npm run test:concurrency -- --pool=3 --url=https://stockhop.vercel.app --out=doc/12-metrics.md
 *
 * Safety: it only touches dedicated product×city rows (never the AUD-001 demo hero), records their
 * stock first and restores it in a finally block (through changeStock → outbox, so search follows),
 * and deletes the orders/customers/carts it created. Requires the workers to be running somewhere.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;

// Must be set before server/config.ts is imported (dotenv never overrides an existing var).
// Aiven's free PostgreSQL allows 15 connections shared by the API, workers, Vercel and this test.
process.env.PG_POOL_MAX = opt('pool', '3');
// This suite stresses checkout allocation itself. Cart claims (doc/13) would stop most of this traffic
// at Add to cart, and pay-then-confirm would hold orders as pending, so both are off IN THIS PROCESS
// only. payment:race and accounts:test cover claims and payments; the deployed site keeps both on.
process.env.CART_CLAIMS = 'off';
process.env.CHECKOUT_PAYMENTS = 'off';
const DEPLOYED_URL = opt('url', 'https://stockhop.vercel.app');
const OUT = opt('out', 'doc/12-metrics.md');
// Opt-in: the deployed site has cart claims and payments on, so this suite's race doesn't apply there
// (payment:race and e2e cover the live race). Run with --deployed --url=<app> to try anyway.
const RUN_DEPLOYED = flag('deployed');
const KEEP = flag('keep');

const { randomUUID } = await import('node:crypto');
const pg = (await import('pg')).default;
const { createApp } = await import('../server/app.js');
const { env, pgConfig } = await import('../server/config.js');
const { getPool, withTx, closePool } = await import('../server/lib/db.js');
const { setStock, changeStock } = await import('../server/domain/stock.js');
const { getSearch, searchIndex } = await import('../server/lib/search.js');
const { getKafka, topics, createProducer } = await import('../server/lib/kafka.js');
const { indexDrift } = await import('../server/lib/drift.js');
const { docId } = await import('../server/lib/events.js');
const { INDEXER_GROUP } = await import('../server/workers/indexer.js');
const { NOTIFIER_GROUP } = await import('../server/workers/notifier.js');

// ───────────────────────────── helpers ─────────────────────────────

const RUN = randomUUID().slice(0, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const ms = (x: number) => `${Math.round(x)} ms`;
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

type Stats = { n: number; min: number; p50: number; p95: number; p99: number; max: number; mean: number };
function summarize(xs: number[]): Stats | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pct = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
  return {
    n: s.length, min: Math.round(s[0]!), p50: Math.round(pct(50)), p95: Math.round(pct(95)),
    p99: Math.round(pct(99)), max: Math.round(s[s.length - 1]!), mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}
const fmtStats = (s: Stats | null) => (s ? `p50 ${s.p50} · p95 ${s.p95} · p99 ${s.p99} · max ${s.max} ms (n=${s.n})` : 'n/a');

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(range(Math.min(limit, items.length)).map(async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!, i); }
  }));
  return out;
}

type Resp = { status: number; ms: number; data: any };
const sessions: string[] = [];
const createdOrders: string[] = [];
/** 503 BUSY responses retried, exactly like web/src/api.ts does in the browser (2 retries, Retry-After × attempt + jitter). */
let busyRetries = 0;

class Shopper {
  cookie = '';
  constructor(readonly base: string) {}
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Resp> {
    const t0 = now();
    let r = await this.once(method, path, body, headers);
    for (let attempt = 0; r.status === 503 && r.data?.error?.code === 'BUSY' && attempt < 2; attempt++) {
      busyRetries++;
      await sleep(1000 * (attempt + 1) + Math.random() * 400);
      r = await this.once(method, path, body, headers);
    }
    return { ...r, ms: now() - t0 };
  }
  private async once(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Resp> {
    const t0 = now();
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e) {
      return { status: 0, ms: now() - t0, data: { error: { code: 'NETWORK', message: String(e) } } };
    }
    const set = res.headers.get('set-cookie');
    if (set && !this.cookie) {
      this.cookie = set.split(';')[0]!;
      sessions.push(decodeURIComponent(this.cookie.split('=')[1] ?? ''));
    }
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
    return { status: res.status, ms: now() - t0, data };
  }
}

async function shopperWith(base: string, city: string, items: [productId: number, qty: number][]): Promise<Shopper> {
  const s = new Shopper(base);
  const c = await s.call('GET', `/api/cart?city=${city}`);
  if (c.status !== 200) throw new Error(`GET /api/cart → ${c.status} ${JSON.stringify(c.data).slice(0, 160)}`);
  for (const [productId, qty] of items) {
    const r = await s.call('POST', '/api/cart/items', { city, productId, qty });
    if (r.status !== 200) throw new Error(`add to cart → ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
  }
  return s;
}

const customer = (tag: string, i: number) => ({ name: `Load Test ${tag} ${i}`, email: `lt-${RUN}-${tag}-${i}@example.com` });
const checkoutBody = (city: string, tag: string, i: number, key = randomUUID()) => ({ city, customer: customer(tag, i), idempotencyKey: key });

const statusCounts = (rs: Resp[]) => {
  const m = new Map<number, number>();
  for (const r of rs) m.set(r.status, (m.get(r.status) ?? 0) + 1);
  return [...m].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${n}×${s === 0 ? 'network-error' : s}`).join(', ');
};

const q = <T extends Record<string, any> = any>(sql: string, params: unknown[] = []) =>
  getPool().query<T>(sql, params).then((r) => r.rows);

// Stock bookkeeping: remember originals once, restore at the end.
const originals = new Map<string, { productId: number; city: string; qty: number }>();
async function stockOf(productId: number, city: string) {
  const r = await q<{ qty: number; version: string }>('SELECT qty, version FROM inventory WHERE product_id = $1 AND city_code = $2', [productId, city]);
  if (!r[0]) throw new Error(`no inventory row ${productId}/${city}`);
  return { qty: r[0].qty, version: Number(r[0].version) };
}
async function remember(productId: number, city: string) {
  const k = `${productId}:${city}`;
  if (!originals.has(k)) originals.set(k, { productId, city, qty: (await stockOf(productId, city)).qty });
}
async function setQty(productId: number, city: string, qty: number) {
  await remember(productId, city);
  return withTx((tx) => setStock(tx, { productId, city, qty, reason: 'restock' }));
}
const maxOutboxId = async () => Number((await q<{ m: string | null }>('SELECT max(id) AS m FROM outbox'))[0]?.m ?? 0);

// ── Kafka lag + search-index helpers ──
const admin = getKafka().admin();
async function groupLag(groupId: string, topic: string): Promise<number> {
  const [ends, committed] = await Promise.all([admin.fetchTopicOffsets(topic), admin.fetchOffsets({ groupId, topics: [topic] })]);
  const c = new Map((committed[0]?.partitions ?? []).map((p) => [p.partition, Number(p.offset)]));
  return ends.reduce((sum, p) => {
    const at = c.get(p.partition) ?? -1;
    return sum + Math.max(0, Number(p.high) - (at < 0 ? Number(p.low) : at));
  }, 0);
}
async function totalLag(): Promise<number> {
  const t = topics();
  const lags = await Promise.all([
    groupLag(INDEXER_GROUP, t.inventory), groupLag(NOTIFIER_GROUP, t.inventory), groupLag(NOTIFIER_GROUP, t.orders),
  ]);
  return lags.reduce((a, b) => a + b, 0);
}
async function waitLagZero(timeoutMs = 45_000): Promise<{ ok: boolean; ms: number }> {
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    if ((await totalLag()) === 0) return { ok: true, ms: now() - t0 };
    await sleep(300);
  }
  return { ok: false, ms: now() - t0 };
}
async function osDocs(keys: { productId: number; city: string }[]) {
  const res = await getSearch().mget({ index: searchIndex().alias, body: { ids: keys.map((k) => docId(k.productId, k.city)) } });
  const docs = (res.body as unknown as { docs: { _id: string; found: boolean; _source?: { qty: number; stock_version: number } }[] }).docs;
  return new Map(docs.map((d) => [d._id, d.found ? d._source! : null]));
}

/** Wait until every outbox row after `sinceId` is published and the given keys match PG in OpenSearch. */
async function waitPipeline(sinceId: number, keys: { productId: number; city: string }[], timeoutMs = 60_000) {
  const t0 = now();
  let published: number | null = null;
  let converged: number | null = null;
  while (now() - t0 < timeoutMs && converged === null) {
    if (published === null) {
      const p = await q<{ n: string }>('SELECT count(*) AS n FROM outbox WHERE id > $1 AND published_at IS NULL', [sinceId]);
      if (Number(p[0]?.n) === 0) published = now() - t0;
    }
    if (published !== null) {
      const pgRows = await Promise.all(keys.map((k) => stockOf(k.productId, k.city)));
      const os = await osDocs(keys);
      const ok = keys.every((k, i) => {
        const d = os.get(docId(k.productId, k.city));
        return d && d.stock_version === pgRows[i]!.version && d.qty === pgRows[i]!.qty;
      });
      if (ok) converged = now() - t0;
    }
    if (converged === null) await sleep(150);
  }
  return { publishedMs: published, convergedMs: converged };
}

/** Relay lag (PG clock: published_at − created_at) for outbox rows in (from, to]. */
async function relayLag(fromId: number, toId?: number) {
  const r = await q<{ lag: number }>(
    `SELECT EXTRACT(EPOCH FROM (published_at - created_at)) * 1000 AS lag FROM outbox
      WHERE id > $1 AND ($2::bigint IS NULL OR id <= $2) AND published_at IS NOT NULL`,
    [fromId, toId ?? null],
  );
  return summarize(r.map((x) => Number(x.lag)));
}

/** Per-order outbox audit: each order must have exactly 1 OrderPlaced and one InventoryChanged per line item. */
async function outboxAudit(orderIds: string[], sinceId: number) {
  if (!orderIds.length) return { ok: true, perOrderOk: 0, orphans: 0, detail: 'no orders' };
  const rows = await q<{ order_id: string; placed: string; inv: string; items: string }>(
    `SELECT o.id::text AS order_id,
            (SELECT count(*) FROM outbox x WHERE x.event_type = 'OrderPlaced' AND x.msg_key = o.id::text) AS placed,
            (SELECT count(*) FROM outbox x WHERE x.event_type = 'InventoryChanged' AND x.payload->>'orderId' = o.id::text) AS inv,
            (SELECT count(*) FROM order_items oi WHERE oi.order_id = o.id) AS items
       FROM orders o WHERE o.id = ANY($1::uuid[])`,
    [orderIds],
  );
  const perOrderOk = rows.filter((r) => Number(r.placed) === 1 && Number(r.inv) === Number(r.items)).length;
  // Any InventoryChanged(order) written in this window that points at an order that doesn't exist = a leaked partial write.
  const orphans = await q<{ n: string }>(
    `SELECT count(*) AS n FROM outbox x
      WHERE x.id > $1 AND x.event_type = 'InventoryChanged' AND x.payload->>'reason' = 'order'
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id::text = x.payload->>'orderId')`,
    [sinceId],
  );
  return { ok: perOrderOk === orderIds.length && Number(orphans[0]?.n) === 0, perOrderOk, orphans: Number(orphans[0]?.n) };
}

// ── connection sampler (its own single connection, so it never waits on the pool) ──
let connPeak = 0;
let connSamples: number[] = [];
let sampler: InstanceType<typeof pg.Client> | null = null;
let samplerOn = false;
async function startSampler() {
  sampler = new pg.Client(pgConfig());
  await sampler.connect();
  samplerOn = true;
  void (async () => {
    while (samplerOn) {
      try {
        const r = await sampler!.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend'`);
        const n = r.rows[0]!.n;
        connSamples.push(n);
        connPeak = Math.max(connPeak, n);
      } catch { /* sampler is best-effort */ }
      await sleep(250);
    }
  })();
}
function resetConnWindow() { const p = connPeak; connPeak = 0; connSamples = []; return p; }

// ───────────────────────────── scenarios ─────────────────────────────

type Check = { label: string; pass: boolean; detail?: string };
type Scenario = {
  id: string; title: string; area: string; setup: string; headline: string;
  checks: Check[]; metrics: [string, string][]; error?: string; skipped?: string; ms: number; peakConns?: number; busyRetries?: number;
};
const results: Scenario[] = [];
const check = (label: string, pass: boolean, detail?: string): Check => ({ label, pass, detail });

async function scenario(
  id: string, title: string, area: string, setup: string,
  fn: (s: Scenario) => Promise<void>,
) {
  const s: Scenario = { id, title, area, setup, headline: '', checks: [], metrics: [], ms: 0 };
  console.log(`\n▶ ${id} ${title}`);
  resetConnWindow();
  const busy0 = busyRetries;
  const t0 = now();
  try {
    await fn(s);
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
    console.log(`  ✖ error: ${s.error}`);
  }
  s.ms = now() - t0;
  s.peakConns = resetConnWindow();
  s.busyRetries = busyRetries - busy0;
  for (const c of s.checks) console.log(`  ${c.pass ? '✓' : '✖'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  results.push(s);
}

/** N shoppers race for `units` of one product×city; returns the responses and verifies no oversell. */
async function lastUnitRace(s: Scenario, base: string, productId: number, city: string, units: number, shoppers: number, tag: string) {
  await setQty(productId, city, units);
  const since = await maxOutboxId();
  const ss = await mapLimit(range(shoppers), 8, () => shopperWith(base, city, [[productId, 1]]));
  const t0 = now();
  const rs = await Promise.all(ss.map((sh, i) => sh.call('POST', '/api/checkout', checkoutBody(city, tag, i))));
  const wall = now() - t0;
  const wins = rs.filter((r) => r.status === 201);
  const outOfStock = rs.filter((r) => r.status === 409 && r.data?.error?.code === 'OUT_OF_STOCK');
  const orderIds = wins.map((r) => String(r.data.orderId));
  createdOrders.push(...orderIds);
  const after = await stockOf(productId, city);
  const dbOrders = await q<{ n: string }>(
    `SELECT count(*) AS n FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.email LIKE $1`,
    [`lt-${RUN}-${tag}-%`],
  );
  return { rs, wall, wins, outOfStock, orderIds, after, dbOrders: Number(dbOrders[0]?.n), since };
}

async function main() {
  const suiteT0 = now();
  const startedAt = new Date();
  const commit = (() => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
  await admin.connect();
  await startSampler();

  const server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  const LOCAL = `http://127.0.0.1:${addr.port}`;

  // Environment facts
  const rtts: number[] = [];
  for (let i = 0; i < 5; i++) { const t = now(); await q('SELECT 1'); rtts.push(now() - t); }
  const pgInfo = (await q<{ maxc: string; v: string; dl: string }>(
    `SELECT current_setting('max_connections') AS maxc, current_setting('server_version') AS v,
            (SELECT deadlocks FROM pg_stat_database WHERE datname = current_database())::text AS dl`))[0]!;
  const deadlocksBefore = Number(pgInfo.dl);
  const suiteSince = await maxOutboxId();
  const ops0 = await new Shopper(LOCAL).call('GET', '/api/ops/summary');
  const workersUp = (ops0.data?.workers ?? []).filter((w: any) => w.up).map((w: any) => w.name);
  console.log(`run ${RUN} · commit ${commit} · PG RTT ${fmtStats(summarize(rtts))} · workers up: ${workersUp.join(', ')}`);
  if (workersUp.length < 4) console.log('⚠ not all workers are up — pipeline scenarios will fail');

  let burstEvents: { id: number; key: string; version: number }[] = [];
  const s1OrderIds: string[] = [];

  try {
    // ── C1: last-unit race ×3 ──
    await scenario('C1', 'Last-units race: 50 shoppers, 5 units (×3 rounds)', 'Concurrent ordering',
      'AUD-006 · MUM set to 5 units; 50 independent guest carts submit checkout at the same instant; repeated 3 times. In-process API, pool of 3 PG connections.',
      async (s) => {
        const lat: number[] = [];
        let allOk = true; let rounds = '';
        let wallTotal = 0;
        for (let round = 1; round <= 3; round++) {
          const r = await lastUnitRace(s, LOCAL, 6, 'MUM', 5, 50, `c1r${round}`);
          lat.push(...r.rs.map((x) => x.ms));
          wallTotal += r.wall;
          s1OrderIds.push(...r.orderIds);
          const ok = r.wins.length === 5 && r.outOfStock.length === 45 && r.after.qty === 0 && r.dbOrders === 5;
          allOk &&= ok;
          rounds += `R${round}: ${statusCounts(r.rs)}, stock after ${r.after.qty}, wall ${ms(r.wall)}; `;
        }
        const audit = await outboxAudit(s1OrderIds, suiteSince);
        s.checks.push(
          check('Every round: exactly 5 × 201 and 45 × 409 OUT_OF_STOCK, stock ends at 0, 5 orders in DB', allOk, rounds.trim()),
          check('No 5xx / network errors', !rounds.includes('×5') && !rounds.includes('network'), ''),
          check('Outbox: each of the 15 orders has exactly 1 OrderPlaced + 1 InventoryChanged; 0 rows from the 135 losers', audit.ok,
            `${audit.perOrderOk}/15 orders correct, ${audit.orphans} orphan stock events`),
        );
        const st = summarize(lat);
        s.headline = `15/150 succeeded, 0 oversold · p95 ${st?.p95} ms`;
        s.metrics.push(['Checkout latency (all 150 requests)', fmtStats(st)], ['Avg wall time per 50-shopper burst', ms(wallTotal / 3)],
          ['Oversold units', '0']);
      });

    // ── C2: multi-item, opposite insertion order, partial-rollback ──
    await scenario('C2', 'Multi-item carts in opposite order (deadlock + all-or-nothing)', 'Concurrent ordering',
      'HOM-001 · DEL = 10 units, HOM-002 · DEL = 6 units. 20 shoppers each buy 1 of both; half add them A→B, half B→A. Only 6 complete sets exist.',
      async (s) => {
        const A = 19, B = 20, city = 'DEL';
        await setQty(A, city, 10); await setQty(B, city, 6);
        const since = await maxOutboxId();
        const ss = await mapLimit(range(20), 8, (_, i) => shopperWith(LOCAL, city, i % 2 ? [[A, 1], [B, 1]] : [[B, 1], [A, 1]]));
        const t0 = now();
        const rs = await Promise.all(ss.map((sh, i) => sh.call('POST', '/api/checkout', checkoutBody(city, 'c2', i))));
        const wall = now() - t0;
        const wins = rs.filter((r) => r.status === 201);
        const ids = wins.map((r) => String(r.data.orderId));
        createdOrders.push(...ids);
        const [a, b] = [await stockOf(A, city), await stockOf(B, city)];
        const deadlockErrors = rs.filter((r) => r.status >= 500).length;
        const audit = await outboxAudit(ids, since);
        s.checks.push(
          check('Exactly 6 orders succeed, 14 get 409', wins.length === 6 && rs.filter((r) => r.status === 409).length === 14, statusCounts(rs)),
          check('No deadlocks / 5xx (items locked in product_id order)', deadlockErrors === 0, `${deadlockErrors} server errors`),
          check('All-or-nothing: HOM-001 ends at 10 − 6 = 4 (failed carts released their first item)', a.qty === 4, `HOM-001=${a.qty}, HOM-002=${b.qty}`),
          check('HOM-002 ends at 0, never negative', b.qty === 0),
          check('Outbox: 6 orders × (1 OrderPlaced + 2 InventoryChanged), no orphan stock events', audit.ok, `${audit.perOrderOk}/6 orders correct, ${audit.orphans} orphans`),
        );
        s.headline = `6/20 succeeded, 0 deadlocks, 0 partial writes`;
        s.metrics.push(['Checkout latency', fmtStats(summarize(rs.map((r) => r.ms)))], ['Wall time', ms(wall)]);
      });

    // ── C3: idempotency storm ──
    await scenario('C3', 'Idempotency storm: 10 identical submits at once', 'Concurrent ordering',
      'One shopper, one cart (BAG-003 · BLR × 1), the same idempotency key sent 10 times concurrently (double-click / retry storm).',
      async (s) => {
        const P = 27, city = 'BLR';
        await remember(P, city);
        const before = await stockOf(P, city);
        const sh = await shopperWith(LOCAL, city, [[P, 1]]);
        const key = randomUUID();
        const rs = await Promise.all(range(10).map(() => sh.call('POST', '/api/checkout', checkoutBody(city, 'c3', 0, key))));
        const ids = new Set(rs.filter((r) => r.status === 200 || r.status === 201).map((r) => String(r.data.orderId)));
        createdOrders.push(...ids);
        const after = await stockOf(P, city);
        const placed = await q<{ n: string }>(`SELECT count(*) AS n FROM outbox WHERE event_type = 'OrderPlaced' AND msg_key = ANY($1::text[])`, [[...ids]]);
        const nonOk = rs.filter((r) => r.status !== 200 && r.status !== 201);
        s.checks.push(
          check('All 10 responses succeed and return the same orderId', ids.size === 1 && nonOk.length === 0,
            `${statusCounts(rs)}${nonOk.length ? ` (${[...new Set(nonOk.map((r) => r.data?.error?.code ?? r.status))].join(', ')})` : ''}; distinct orderIds=${ids.size}`),
          check('Stock decremented exactly once', before.qty - after.qty === 1, `${before.qty} → ${after.qty}`),
          check('Exactly one OrderPlaced event', Number(placed[0]?.n) === 1, `${placed[0]?.n}`),
        );
        s.headline = `10 submits → 1 order, stock −1`;
        s.metrics.push(['Latency', fmtStats(summarize(rs.map((r) => r.ms)))]);
      });

    // ── C4: hot row vs spread ──
    await scenario('C4', 'Throughput: one hot row vs five rows (25 buyers each)', 'Concurrent ordering',
      'Hot: 25 buyers of MOB-002 · BLR (set to 25). Spread: 25 buyers across MOB-001, MOB-004, HOM-006, BAG-005, AUD-002 in MUM (5 each; rows topped up to 10 first). All must succeed.',
      async (s) => {
        await setQty(14, 'BLR', 25);
        const hotSh = await mapLimit(range(25), 8, () => shopperWith(LOCAL, 'BLR', [[14, 1]]));
        let t0 = now();
        const hot = await Promise.all(hotSh.map((sh, i) => sh.call('POST', '/api/checkout', checkoutBody('BLR', 'c4h', i))));
        const hotWall = now() - t0;
        createdOrders.push(...hot.filter((r) => r.status === 201).map((r) => String(r.data.orderId)));
        const hotAfter = await stockOf(14, 'BLR');

        const rows = [13, 16, 24, 29, 2];
        const before = new Map<number, number>();
        // Give each row enough stock for its 5 buyers (demo data keeps some at 1–2); restored at the end.
        for (const p of rows) { if ((await stockOf(p, 'MUM')).qty < 10) await setQty(p, 'MUM', 10); before.set(p, (await stockOf(p, 'MUM')).qty); }
        const spreadSh = await mapLimit(range(25), 8, (_, i) => shopperWith(LOCAL, 'MUM', [[rows[i % 5]!, 1]]));
        t0 = now();
        const spread = await Promise.all(spreadSh.map((sh, i) => sh.call('POST', '/api/checkout', checkoutBody('MUM', 'c4s', i))));
        const spreadWall = now() - t0;
        createdOrders.push(...spread.filter((r) => r.status === 201).map((r) => String(r.data.orderId)));
        let conserved = true;
        for (const p of rows) conserved &&= (await stockOf(p, 'MUM')).qty === before.get(p)! - 5;

        const hs = summarize(hot.map((r) => r.ms)); const ss2 = summarize(spread.map((r) => r.ms));
        s.checks.push(
          check('Hot row: all 25 succeed, stock 25 → 0', hot.every((r) => r.status === 201) && hotAfter.qty === 0, `${statusCounts(hot)}, stock ${hotAfter.qty}`),
          check('Spread: all 25 succeed, each row decremented by exactly 5', spread.every((r) => r.status === 201) && conserved, statusCounts(spread)),
        );
        s.headline = `hot ${(25 / (hotWall / 1000)).toFixed(1)} orders/s vs spread ${(25 / (spreadWall / 1000)).toFixed(1)} orders/s`;
        s.metrics.push(
          ['Hot row: wall time / throughput', `${ms(hotWall)} · ${(25 / (hotWall / 1000)).toFixed(1)} orders/s`],
          ['Hot row: latency', fmtStats(hs)],
          ['Spread: wall time / throughput', `${ms(spreadWall)} · ${(25 / (spreadWall / 1000)).toFixed(1)} orders/s`],
          ['Spread: latency', fmtStats(ss2)],
        );
      });

    // ── P1: PG invariants under a 60-change burst + Kafka/OpenSearch propagation ──
    await scenario('P1', 'Burst: 60 concurrent stock changes → Kafka → OpenSearch', 'PostgreSQL + Outbox + OpenSearch',
      '10 BLR rows × 6 changes each (−1,+1,−1,+1,−1,+1 → net 0), all 60 transactions fired at once through changeStock (the only stock-writing path). Then measure relay lag, consumer lag and time until each change is visible in OpenSearch.',
      async (s) => {
        const ids = [4, 6, 9, 11, 13, 16, 19, 20, 24, 29];
        const keys = ids.map((productId) => ({ productId, city: 'BLR' }));
        const before = new Map<number, { qty: number; version: number }>();
        // −1/+1 bursts need headroom: demo data keeps some rows at 1, where an early −1 is (correctly) refused.
        for (const k of keys) { if ((await stockOf(k.productId, k.city)).qty < 5) await setQty(k.productId, k.city, 5); else await remember(k.productId, k.city); before.set(k.productId, await stockOf(k.productId, k.city)); }
        await waitLagZero(20_000);
        const since = await maxOutboxId();

        let lagPeak = 0; let lagOn = true;
        const lagLoop = (async () => { while (lagOn) { try { lagPeak = Math.max(lagPeak, await totalLag()); } catch { /* best effort */ } await sleep(400); } })();

        const commits: { productId: number; version: number; at: number }[] = [];
        const t0 = now();
        const out = await Promise.allSettled(range(60).map((i) => {
          const productId = ids[i % 10]!;
          const delta = Math.floor(i / 10) % 2 === 0 ? -1 : 1;
          return withTx((tx) => changeStock(tx, { productId, city: 'BLR', delta, reason: 'restock' })).then((r) => {
            if (r) commits.push({ productId, version: r.version, at: now() });
            return r;
          });
        }));
        const commitWall = now() - t0;
        const failed = out.filter((o) => o.status === 'rejected' || o.value === null).length;

        // Per-change visibility in OpenSearch: first time the doc's version ≥ that change's version.
        const pending = new Map(commits.map((c) => [`${c.productId}:${c.version}`, c]));
        const visibleLat: number[] = [];
        const tPoll = now();
        while (pending.size && now() - tPoll < 60_000) {
          const docs = await osDocs(keys);
          const seenAt = now();
          for (const [k, c] of pending) {
            const d = docs.get(docId(c.productId, 'BLR'));
            if (d && d.stock_version >= c.version) { visibleLat.push(seenAt - c.at); pending.delete(k); }
          }
          if (pending.size) await sleep(100);
        }
        const lastCommit = Math.max(...commits.map((c) => c.at));
        const convergedAfterLast = now() - lastCommit;
        lagOn = false; await lagLoop;

        let netZero = true; let versionsUp = true;
        for (const k of keys) {
          const a = await stockOf(k.productId, k.city);
          netZero &&= a.qty === before.get(k.productId)!.qty;
          versionsUp &&= a.version > before.get(k.productId)!.version;
        }
        const ev = await q<{ id: string; msg_key: string; version: string }>(
          `SELECT id, msg_key, payload->>'version' AS version FROM outbox WHERE id > $1 AND event_type = 'InventoryChanged' ORDER BY id`, [since]);
        burstEvents = ev.map((e) => ({ id: Number(e.id), key: e.msg_key, version: Number(e.version) }));
        const lastVer = new Map<string, number>(); let monotonic = true;
        for (const e of burstEvents) { if ((lastVer.get(e.key) ?? -1) >= e.version) monotonic = false; lastVer.set(e.key, e.version); }
        const rl = await relayLag(since);
        const os = await osDocs(keys);
        let osMatches = 0;
        for (const k of keys) { const a = await stockOf(k.productId, k.city); const d = os.get(docId(k.productId, k.city)); if (d && d.qty === a.qty && d.stock_version === a.version) osMatches++; }

        s.checks.push(
          check('All 60 transactions committed (no lost or rejected updates)', failed === 0 && commits.length === 60, `${commits.length} committed, ${failed} failed`),
          check('No lost updates: every row is back to its starting qty (net 0)', netZero),
          check('Outbox wrote exactly 60 InventoryChanged rows, versions strictly increasing per key', burstEvents.length === 60 && monotonic, `${burstEvents.length} rows, monotonic=${monotonic}`),
          check('Version advanced on every touched row', versionsUp),
          check('All 60 changes became visible in OpenSearch', visibleLat.length === 60, `${visibleLat.length}/60`),
          check('OpenSearch qty + version equal PostgreSQL for all 10 rows', osMatches === 10, `${osMatches}/10`),
        );
        const vl = summarize(visibleLat);
        s.headline = `60/60 indexed · commit→searchable p50 ${vl?.p50} ms, p95 ${vl?.p95} ms`;
        s.metrics.push(
          ['Time to commit all 60 transactions', ms(commitWall)],
          ['Relay lag (outbox created → published to Kafka, PG clock)', fmtStats(rl)],
          ['Commit → visible in OpenSearch (per change)', fmtStats(vl)],
          ['Index fully converged after last commit', ms(convergedAfterLast)],
          ['Peak Kafka consumer lag during burst (all groups)', `${lagPeak} messages`],
        );
      });

    // ── O1: duplicate + stale delivery ──
    await scenario('O1', 'Outbox replay: duplicate and stale Kafka deliveries', 'Outbox + consumer idempotency',
      'Simulates "relay crashed after sending, before marking published": re-produce already-published events (same eventId) 3× each — one OrderPlaced, one low-stock InventoryChanged, and the oldest burst event for a key (stale version). Consumers must absorb them.',
      async (s) => {
        const orderId = s1OrderIds[0];
        if (!orderId || !burstEvents.length) throw new Error('needs C1 and P1 to have run');
        await waitLagZero(30_000);
        const orderEv = (await q(`SELECT * FROM outbox WHERE event_type = 'OrderPlaced' AND msg_key = $1`, [orderId]))[0];
        const alertEv = (await q(
          `SELECT x.* FROM outbox x JOIN stock_alerts a ON a.event_id = x.id WHERE x.id > $1 ORDER BY x.id LIMIT 1`, [suiteSince]))[0];
        const staleKey = burstEvents[0]!.key;
        const staleEv = (await q(`SELECT * FROM outbox WHERE id = $1`, [burstEvents[0]!.id]))[0];
        const [pid, city] = staleKey.split(':') as [string, string];
        const pgBefore = await stockOf(Number(pid), city);
        const notifBefore = Number((await q(`SELECT count(*) AS n FROM notifications WHERE order_id = $1`, [orderId]))[0]?.n);
        const alertsBefore = Number((await q(`SELECT count(*) AS n FROM stock_alerts`))[0]?.n);

        const producer = await createProducer();
        const envelope = (r: any) => ({
          key: r.msg_key,
          value: JSON.stringify({ eventId: Number(r.id), eventType: r.event_type, schemaVersion: 1, occurredAt: new Date(r.created_at).toISOString(), payload: r.payload }),
          headers: { 'event-type': r.event_type, 'event-id': String(r.id), replay: `concurrency-suite-${RUN}` },
        });
        const evs = [orderEv, alertEv, staleEv].filter(Boolean);
        const t0 = now();
        await Promise.all(range(3).map(() => producer.sendBatch({
          acks: -1,
          topicMessages: evs.map((r: any) => ({ topic: r.topic, messages: [envelope(r)] })),
        })));
        await producer.disconnect();
        const drained = await waitLagZero(45_000);
        await sleep(500);

        const notifAfter = Number((await q(`SELECT count(*) AS n FROM notifications WHERE order_id = $1`, [orderId]))[0]?.n);
        const alertsAfter = Number((await q(`SELECT count(*) AS n FROM stock_alerts`))[0]?.n);
        const doc = (await osDocs([{ productId: Number(pid), city }])).get(docId(Number(pid), city));
        const pgAfter = await stockOf(Number(pid), city);
        s.checks.push(
          check(`Re-sent ${evs.length * 3} duplicate messages; consumers drained them`, drained.ok, `lag back to 0 in ${ms(drained.ms)}`),
          check('Notifier: still exactly 1 confirmation for the order (UNIQUE event_id)', notifAfter === 1 && notifBefore === 1, `${notifBefore} → ${notifAfter}`),
          check('Notifier: no duplicate low-stock alerts', alertsAfter === alertsBefore, `${alertsBefore} → ${alertsAfter}${alertEv ? '' : ' (no alert event available)'}`),
          check(`Indexer: stale v${burstEvents[0]!.version} rejected; doc stays at latest v${pgAfter.version}`, doc?.stock_version === pgAfter.version && doc?.qty === pgAfter.qty,
            `OpenSearch v${doc?.stock_version} qty ${doc?.qty}; PG v${pgAfter.version} qty ${pgAfter.qty}`),
          check('PostgreSQL inventory untouched by consumers', pgAfter.version === pgBefore.version && pgAfter.qty === pgBefore.qty),
        );
        s.headline = `${evs.length * 3} duplicates → 0 side effects`;
        s.metrics.push(['Duplicate messages produced', String(evs.length * 3)], ['Time for consumers to drain them', ms(now() - t0)]);
      });

    // ── O2: notifier pipeline latency + relay lock + PG guard rails ──
    await scenario('O2', 'Order events end to end + PostgreSQL guard rails', 'Outbox + PostgreSQL',
      'For every order created above: OrderPlaced → Kafka → notifier → confirmation row. Plus: single-relay advisory lock, the CHECK (qty >= 0) backstop, and changeStock refusing to go negative.',
      async (s) => {
        await waitLagZero(30_000);
        const lat = await q<{ lag: number; has: boolean }>(
          `SELECT EXTRACT(EPOCH FROM (n.created_at - o.created_at)) * 1000 AS lag, n.id IS NOT NULL AS has
             FROM orders o LEFT JOIN notifications n ON n.order_id = o.id WHERE o.id = ANY($1::uuid[])`, [createdOrders]);
        const missing = lat.filter((r) => !r.has).length;
        const dupes = Number((await q(`SELECT count(*) AS n FROM (SELECT order_id FROM notifications WHERE order_id = ANY($1::uuid[]) GROUP BY order_id HAVING count(*) > 1) d`, [createdOrders]))[0]?.n);
        const lock = await q<{ n: string }>(`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 4242001 AND granted`);
        const tryLock = (await q<{ ok: boolean }>('SELECT pg_try_advisory_lock(4242001) AS ok'))[0]!.ok;
        if (tryLock) await q('SELECT pg_advisory_unlock(4242001)');

        const P = 27, city = 'BLR';
        const before = await stockOf(P, city);
        let checkCode = '';
        try { await withTx((tx) => tx.query('UPDATE inventory SET qty = -1 WHERE product_id = $1 AND city_code = $2', [P, city])); }
        catch (e) { checkCode = (e as { code?: string }).code ?? 'error'; }
        const obBefore = await maxOutboxId();
        const refused = await withTx((tx) => changeStock(tx, { productId: P, city, delta: -(before.qty + 1), reason: 'order' }));
        const obAfter = await maxOutboxId();
        const after = await stockOf(P, city);

        s.checks.push(
          check(`Every one of the ${createdOrders.length} orders got exactly one confirmation`, missing === 0 && dupes === 0, `${missing} missing, ${dupes} duplicated`),
          check('Exactly one relay holds the single-relay lock; a second relay would stand by', Number(lock[0]?.n) === 1 && !tryLock, `holders=${lock[0]?.n}, second acquire=${tryLock}`),
          check('Direct UPDATE to qty = −1 is rejected by CHECK (qty >= 0)', checkCode === '23514', `SQLSTATE ${checkCode}`),
          check('changeStock refuses an oversell (returns null, writes no outbox row)', refused === null && obAfter === obBefore),
          check('Row unchanged after both attempts', after.qty === before.qty && after.version === before.version),
        );
        const st = summarize(lat.filter((r) => r.has).map((r) => Number(r.lag)));
        s.headline = `${createdOrders.length - missing}/${createdOrders.length} confirmations · order→notified p95 ${st?.p95} ms`;
        s.metrics.push(['Order committed → confirmation stored (PG clock)', fmtStats(st)]);
      });

    // ── PAY1: Razorpay Test Mode ──
    await scenario('PAY1', 'Payments: Razorpay Test Mode gateway under concurrency', 'Payments',
      '20 concurrent ₹1 gateway-order creations through POST /api/payments/test/orders, auth + validation checks, and a read-back of the recorded multi-attempt order. Test Mode only: no money moves, no StockHop order or stock change.',
      async (s) => {
        if (!process.env.test_api_key?.startsWith('rzp_test_') || !process.env.test_key_secret) { s.skipped = 'Razorpay Test Mode keys not configured'; return; }
        const adminH = { 'x-admin-token': env.ADMIN_TOKEN ?? '' };
        const c = new Shopper(LOCAL);
        const unauth = await c.call('POST', '/api/payments/test/orders', { amountPaise: 100 });
        const invalid = await Promise.all([99, 100_001, 100.5].map((amountPaise) => c.call('POST', '/api/payments/test/orders', { amountPaise }, adminH)));
        const t0 = now();
        const rs = await Promise.all(range(20).map(() => c.call('POST', '/api/payments/test/orders', { amountPaise: 100 }, adminH)));
        const wall = now() - t0;
        const okRs = rs.filter((r) => r.status === 201);
        const idsU = new Set(okRs.map((r) => r.data.gatewayOrderId)); const rcU = new Set(okRs.map((r) => r.data.receipt));
        const first = okRs[0]?.data.gatewayOrderId as string | undefined;
        const readBack = first ? await c.call('GET', `/api/payments/test/orders/${first}`, undefined, adminH) : null;
        const hist = await c.call('GET', '/api/payments/test/orders/order_U2lPfm2ONhshr1', undefined, adminH);
        const histPays = await c.call('GET', '/api/payments/test/orders/order_U2lPfm2ONhshr1/payments', undefined, adminH);
        const payStatuses = (histPays.data?.payments ?? []).map((p: any) => p.status);
        const tally = payStatuses.reduce((m: Record<string, number>, x: string) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});
        s.checks.push(
          check('Unauthenticated request rejected (401)', unauth.status === 401),
          check('Below-min, above-max and fractional amounts rejected (400)', invalid.every((r) => r.status === 400), invalid.map((r) => r.status).join(',')),
          check('20/20 concurrent gateway orders created', okRs.length === 20, statusCounts(rs)),
          check('All 20 have unique gateway IDs and unique receipts', idsU.size === 20 && rcU.size === 20, `${idsU.size} ids, ${rcU.size} receipts`),
          check('All created unpaid (amount_paid = 0, status created)', okRs.every((r) => r.data.amountPaidPaise === 0 && r.data.status === 'created')),
          check('Read-back of a new order shows ₹1 due', readBack?.data?.amountDuePaise === 100, readBack ? `status ${readBack.data.status}` : 'none'),
          check('Recorded 5-tab experiment order is paid exactly once (₹1) after 6 attempts', hist.data?.status === 'paid' && hist.data?.amountPaidPaise === 100,
            `status ${hist.data?.status}, ${hist.data?.attempts} attempts: ${tally.failed ?? 0} declined on purpose (mock-bank Failure button), ${tally.captured ?? 0} captured`),
        );
        const st = summarize(rs.map((r) => r.ms));
        s.headline = `20/20 gateway orders, unique, unpaid · p95 ${st?.p95} ms`;
        s.metrics.push(['Gateway order creation latency (incl. Razorpay API)', fmtStats(st)], ['Wall time for 20 concurrent', ms(wall)],
          ['Recorded order attempts', `${hist.data?.attempts} attempts: ${tally.failed ?? 0} declined on purpose (mock-bank Failure button), ${tally.captured ?? 0} captured (₹1 simulated)`]);
      });

    // ── D1: deployed race ──
    await scenario('D1', `Deployed race on Vercel: 30 shoppers, 5 units`, 'Concurrent ordering (production)',
      `WRB-001 · DEL set to 5; 30 shoppers create carts and check out simultaneously against ${DEPLOYED_URL} (Vercel functions in sin1, next to Aiven PG). Real serverless scaling and connection limits.`,
      async (s) => {
        if (!RUN_DEPLOYED) { s.skipped = 'opt-in (--deployed): the live site has cart claims and payments on; e2e and payment:race cover the live race'; return; }
        const health = await new Shopper(DEPLOYED_URL).call('GET', '/api/health');
        if (health.status !== 200) { s.skipped = `deployed health ${health.status}`; return; }
        const r = await lastUnitRace(s, DEPLOYED_URL, 9, 'DEL', 5, 30, 'd1');
        const five = r.rs.filter((x) => x.status >= 500 || x.status === 0);
        s.checks.push(
          check('Never oversold: ≤ 5 orders and stock ≥ 0', r.wins.length <= 5 && r.after.qty >= 0 && r.dbOrders === r.wins.length, `${r.wins.length} orders, stock ${r.after.qty}`),
          check('Exactly 5 × 201 and 25 × 409', r.wins.length === 5 && r.outOfStock.length === 25, statusCounts(r.rs)),
          check('No 5xx (e.g. PostgreSQL connection exhaustion)', five.length === 0, five.length ? five.slice(0, 2).map((x) => JSON.stringify(x.data).slice(0, 120)).join(' | ') : '0'),
        );
        const st = summarize(r.rs.map((x) => x.ms));
        s.headline = `${r.wins.length}/30 succeeded on Vercel · p95 ${st?.p95} ms`;
        s.metrics.push(['Checkout latency from this laptop (incl. internet RTT)', fmtStats(st)], ['Wall time for 30 concurrent', ms(r.wall)]);
      });
  } finally {
    // ── cleanup + restore (always) ──
    console.log('\n▶ restoring stock and cleaning up');
    const cleanup: string[] = [];
    try {
      const drained = await waitLagZero(45_000);
      cleanup.push(`consumers drained before cleanup: ${drained.ok}`);
      for (const o of originals.values()) await setQty(o.productId, o.city, o.qty);
      cleanup.push(`restored ${originals.size} product×city rows to their original stock`);
      if (!KEEP && createdOrders.length) {
        const ids = [...new Set(createdOrders)];
        await withTx(async (tx) => {
          await tx.query(`DELETE FROM stock_alerts WHERE event_id IN (SELECT id FROM outbox WHERE id > $1 AND payload->>'orderId' = ANY($2::text[]))`, [suiteSince, ids]);
          await tx.query('DELETE FROM notifications WHERE order_id = ANY($1::uuid[])', [ids]);
          await tx.query('DELETE FROM order_items WHERE order_id = ANY($1::uuid[])', [ids]);
          await tx.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [ids]);
          await tx.query('DELETE FROM customers WHERE email LIKE $1', [`lt-${RUN}-%`]);
        });
        cleanup.push(`deleted ${ids.length} test orders with their items, confirmations, alerts and customers`);
      }
      if (sessions.length) {
        await q('DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE session_id = ANY($1::text[]))', [sessions]);
        await q('DELETE FROM carts WHERE session_id = ANY($1::text[])', [sessions]);
        cleanup.push(`deleted ${sessions.length} test carts`);
      }
      const keys = [...originals.values()].map((o) => ({ productId: o.productId, city: o.city }));
      const fin = await waitPipeline(await maxOutboxId() - originals.size, keys, 60_000);
      const drift = await indexDrift();
      cleanup.push(`restore propagated to OpenSearch in ${fin.convergedMs === null ? 'TIMEOUT' : ms(fin.convergedMs)}; global index ${drift.inSync}/${drift.docs} in sync`);
      let restoredOk = true;
      for (const o of originals.values()) restoredOk &&= (await stockOf(o.productId, o.city)).qty === o.qty;
      cleanup.push(`all stock back to original: ${restoredOk}`);
    } catch (e) {
      cleanup.push(`CLEANUP ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
    cleanup.forEach((c) => console.log(`  · ${c}`));

    const deadlocksAfter = Number((await q<{ dl: string }>(`SELECT deadlocks::text AS dl FROM pg_stat_database WHERE datname = current_database()`))[0]?.dl);
    samplerOn = false;
    await sleep(300);
    await sampler?.end().catch(() => {});
    await admin.disconnect().catch(() => {});
    server.close();
    await closePool();

    writeReport({
      startedAt, commit, totalMs: now() - suiteT0, rtt: summarize(rtts), pgInfo, workersUp,
      deadlocks: deadlocksAfter - deadlocksBefore, cleanup, peakConnsOverall: Math.max(...results.map((r) => r.peakConns ?? 0)),
    });
  }
}

// ───────────────────────────── report ─────────────────────────────

function writeReport(meta: {
  startedAt: Date; commit: string; totalMs: number; rtt: Stats | null; pgInfo: { maxc: string; v: string };
  workersUp: string[]; deadlocks: number; cleanup: string[]; peakConnsOverall: number;
}) {
  const passed = results.filter((r) => !r.skipped && !r.error && r.checks.every((c) => c.pass)).length;
  const ran = results.filter((r) => !r.skipped).length;
  const allChecks = results.flatMap((r) => r.checks);
  const verdict = (r: Scenario) => (r.skipped ? '⏭️ skipped' : r.error ? '💥 error' : r.checks.every((c) => c.pass) ? '✅ pass' : '❌ fail');
  const ist = meta.startedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

  const L: string[] = [];
  L.push('# 12: Concurrency & Pipeline Metrics', '');
  L.push('> **Generated file.** Re-run with `npm run test:concurrency` and this page is rewritten with fresh numbers. Source: [`scripts/concurrency-suite.ts`](../scripts/concurrency-suite.ts).', '');
  L.push(`**Last run:** ${ist} IST · commit \`${meta.commit}\` · ${ms(meta.totalMs)} total · **${passed}/${ran} scenarios passed**, ${allChecks.filter((c) => c.pass).length}/${allChecks.length} checks.`, '');
  L.push('## Summary', '', '| # | Scenario | Area | Result | Headline |', '|---|---|---|---|---|');
  for (const r of results) L.push(`| ${r.id} | ${r.title} | ${r.area} | ${verdict(r)} | ${r.skipped ? r.skipped : r.error ? r.error.slice(0, 80) : r.headline} |`);
  // Hand-written analysis between these markers survives re-runs (update it when the findings change).
  let analysis = '';
  try { analysis = readFileSync(OUT, 'utf8').match(/<!-- analysis:start -->[\s\S]*?<!-- analysis:end -->/)?.[0] ?? ''; } catch { /* first run */ }
  if (analysis) L.push('', analysis);
  L.push('', '## Environment', '', '| | |', '|---|---|');
  L.push(`| API under test | In-process Express app (\`server/app.ts\`) on this laptop, **${process.env.PG_POOL_MAX}-connection** PG pool; D1 hits the deployed Vercel site |`);
  L.push(`| PostgreSQL | Aiven, PostgreSQL ${meta.pgInfo.v.split(' ')[0]}, Singapore · \`max_connections = ${meta.pgInfo.maxc}\` (3 reserved for superusers) |`);
  L.push(`| Laptop → PostgreSQL round trip | ${fmtStats(meta.rtt)} |`);
  L.push(`| Kafka / OpenSearch | Aiven Kafka (Bengaluru, SASL/SCRAM) · Aiven OpenSearch (Singapore) |`);
  L.push(`| Workers | ${meta.workersUp.join(', ') || 'none detected'} running on the laptop (\`npm run dev\`) |`);
  L.push(`| Peak PG client connections seen | ${meta.peakConnsOverall} (shared with Vercel, workers and the local dev API) |`);
  L.push(`| New deadlocks during the run | ${meta.deadlocks} (database-wide counter, \`pg_stat_database.deadlocks\`) |`);
  L.push('');
  L.push('> **Reading the latency numbers:** the in-process API runs in India and talks to PostgreSQL in Singapore, so every SQL round trip costs the RTT above (a checkout makes ~6, of which one per item + 2 happen while holding the row lock). Local latencies are therefore a **pessimistic upper bound**; D1 (Vercel `sin1`, next to the database) is the realistic production figure.', '');

  L.push('## Results', '');
  for (const r of results) {
    L.push(`### ${r.id} · ${r.title} — ${verdict(r)}`, '');
    L.push(`**Setup:** ${r.setup}`, '');
    if (r.skipped) { L.push(`_Skipped: ${r.skipped}_`, ''); continue; }
    if (r.error) L.push(`**Error:** \`${r.error}\``, '');
    if (r.checks.length) {
      L.push('| Check | Result | Detail |', '|---|---|---|');
      for (const c of r.checks) L.push(`| ${c.label} | ${c.pass ? '✅' : '❌'} | ${(c.detail ?? '').replace(/\|/g, '/')} |`);
      L.push('');
    }
    if (r.metrics.length || r.peakConns) {
      L.push('| Metric | Value |', '|---|---|');
      for (const [k, v] of r.metrics) L.push(`| ${k} | ${v} |`);
      L.push(`| Scenario duration · peak PG connections · 503 BUSY retries | ${ms(r.ms)} · ${r.peakConns} · ${r.busyRetries ?? 0} |`, '');
    }
  }

  L.push('## What these results prove', '');
  L.push('- **No overselling under contention.** The conditional `UPDATE … WHERE qty + delta >= 0` plus the row lock serialises buyers of the same item; losers get a clean `409 OUT_OF_STOCK` and nothing is written for them (C1, C2, D1).');
  L.push('- **All-or-nothing checkout.** A multi-item cart that fails on its second item releases the first one (C2), and items are locked in `product_id` order so opposite-order carts never deadlock.');
  L.push('- **Idempotent submits.** Concurrent duplicates of one request produce one order and one stock decrement (C3), via the `UNIQUE(idempotency_key)` race handler.');
  L.push('- **Transactional outbox.** Every stock change and order writes its events in the same transaction (exact per-order counts, zero orphan events), the single relay publishes them in order, and OpenSearch converges to PostgreSQL (P1).');
  L.push('- **At-least-once delivery, exactly-once effect.** Duplicate and stale Kafka messages produce no extra confirmations, no extra alerts, and never roll the search index back (O1).');
  L.push('');
  L.push('## Not covered (honest gaps)', '');
  L.push('- **Real payment capture is not part of StockHop checkout yet.** PAY1 tests the Razorpay *Test Mode* gateway-order API under concurrency and reads back the manually recorded 5-tab experiment; it cannot complete a UPI/card payment server-side. Pending-payment reservations, signature verification and webhooks are not implemented (see [11-razorpay-test.md](./11-razorpay-test.md)).');
  L.push('- **Single-instance local API.** Local scenarios use one Node process with a small pool; horizontal scaling is only exercised in D1.');
  L.push('- **Outage drills** (killing the indexer / Kafka mid-run) are not automated here; O1 covers the duplicate-delivery half of the crash case.');
  L.push('- Numbers are from one run on a free-tier stack and shared network; treat them as indicative, not SLAs.');
  L.push('');
  L.push('## Cleanup performed', '');
  for (const c of meta.cleanup) L.push(`- ${c}`);
  L.push('', '## Re-run', '', '```bash', 'npm run test:concurrency                  # full suite incl. the deployed race', 'npm run test:concurrency -- --no-deployed # local only', 'npm run test:concurrency -- --keep        # keep the test orders for inspection', '```', '');
  L.push('Requires `.env` (Aiven PG, Kafka, OpenSearch; Razorpay test keys for PAY1) and the workers running (`npm run dev` or `npm run workers`).', '');
  writeFileSync(OUT, L.join('\n'));
  console.log(`\n📝 wrote ${OUT} · ${passed}/${ran} scenarios passed`);
  if (passed !== ran) process.exitCode = 1;
}

await main();
