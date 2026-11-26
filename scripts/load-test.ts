/**
 * Load test against a DEPLOYED StockHop (default: the Aiven App Runtime URL).
 *
 *   npm run load:test                                 all three phases
 *   npm run load:test -- --url=https://… --skip-checkout
 *   npm run load:test -- --only=stock|search|checkout --out=report.json
 *   npm run load:test -- --only=new                  doc/21 features (type-ahead, shops, presence, together)
 *   npm run load:test -- --compare --out=ab.json     A/B: original OpenSearch-only path vs Valkey,
 *                                                     with OpenSearch node stats per run
 *
 * A. Live-stock polling ramp: N virtual shoppers, each polling /api/stock for 12 cards every 1.5 s,
 *    exactly like open browsers. Reports client latency (includes the network from this laptop) and
 *    server time from the Server-Timing header, plus which store answered (Valkey or OpenSearch).
 * B. Search: N users searching back-to-back (closed loop) with typo queries → OpenSearch.
 * C. Checkout stampede on the live site: 40 shoppers, 5 units, all checkouts fired at once. Verified
 *    in PostgreSQL (exactly 5 orders, qty 0). Uses one non-demo row and restores its stock afterwards.
 *    Needs DATABASE_URL locally (one connection) to set and restore stock.
 *
 * doc/21 features (`--only=new` runs all four; or one of typeahead|shops|presence|together):
 * D. Type-ahead: shoppers typing a word letter by letter (one /suggest per keystroke, ~180 ms apart,
 *    like the box's 120 ms debounce at normal typing speed), then a pause. Server = suggest tookMs.
 * E. Shops: storefront browsing and searching inside a shop (typos), plus shop-name searches.
 * F. Presence: open product pages heartbeating /presence every 5 s (the retailer "Live now" feed).
 * G. Bought together: product pages opening /together (ClickHouse co-purchases + OpenSearch).
 */
import { randomUUID } from 'node:crypto';
// Phase C keeps ONE database connection for its whole run: under load the shared PostgreSQL can be
// full, and a pool that drops idle sockets may not get a slot back to restore stock.
process.env.PG_POOL_MAX = '1';
process.env.PG_IDLE_TIMEOUT_MS = '600000';
await import('dotenv/config');

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const flag = (n: string) => argv.includes(`--${n}`);
const BASE = opt('url', 'https://lucky-infinite-humpback.eur-1.aiven.app').replace(/\/$/, '');
const CITIES = ['BLR', 'MUM', 'DEL'] as const;

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const r1 = (x: number) => Math.round(x * 10) / 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]!;

interface Sample { ms: number; status: number; serverMs?: number; source?: string }

function summarize(label: string, samples: Sample[], seconds: number) {
  const ok = samples.filter((s) => s.status >= 200 && s.status < 300);
  const client = ok.map((s) => s.ms);
  const server = ok.map((s) => s.serverMs).filter((x): x is number => x !== undefined);
  const sources: Record<string, number> = {};
  for (const s of ok) if (s.source) sources[s.source] = (sources[s.source] ?? 0) + 1;
  const errors: Record<string, number> = {};
  for (const s of samples) if (!(s.status >= 200 && s.status < 300)) errors[s.status || 'network'] = (errors[s.status || 'network'] ?? 0) + 1;
  return {
    stage: label,
    requests: samples.length,
    rps: r1(samples.length / seconds),
    errorRate: `${r1((100 * (samples.length - ok.length)) / Math.max(1, samples.length))}%`,
    clientP50: r1(pct(client, 50)), clientP95: r1(pct(client, 95)), clientP99: r1(pct(client, 99)),
    serverP50: r1(pct(server, 50)), serverP95: r1(pct(server, 95)), serverP99: r1(pct(server, 99)),
    sources, errors,
  };
}

async function timed(url: string, init?: RequestInit): Promise<Sample & { body?: unknown; res?: Response }> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    const ms = performance.now() - t0;
    const st = res.headers.get('server-timing') ?? '';
    const dur = /dur=([\d.]+)/.exec(st)?.[1];
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ms, status: res.status, serverMs: dur ? Number(dur) : undefined, source: res.headers.get('x-stock-source') ?? undefined, body, res };
  } catch {
    return { ms: performance.now() - t0, status: 0 };
  }
}

// ---------------------------------------------------------------------------------------------
async function productIds(): Promise<number[]> {
  const ids = new Set<number>();
  for (const q of ['', 'earphones', 'bottle', 'speaker', 'bag', 'charger']) {
    const r = await timed(`${BASE}/api/search?city=BLR&q=${encodeURIComponent(q)}&size=24`);
    for (const it of ((r.body as { items?: { productId: number }[] })?.items ?? [])) ids.add(it.productId);
  }
  return ids.size >= 12 ? [...ids] : Array.from({ length: 30 }, (_, i) => i + 1);
}

async function stockStage(ids: number[], users: number, seconds: number, cacheOff: boolean) {
  const samples: Sample[] = [];
  const end = Date.now() + seconds * 1000;
  await Promise.all(Array.from({ length: users }, async () => {
    await sleep(Math.random() * 1500);
    const city = pick(CITIES);
    const mine = [...ids].sort(() => Math.random() - 0.5).slice(0, 12);
    while (Date.now() < end) {
      const t0 = Date.now();
      samples.push(await timed(`${BASE}/api/stock?city=${city}&ids=${mine.join(',')}${cacheOff ? '&cache=off' : ''}`));
      await sleep(Math.max(0, 1500 - (Date.now() - t0)));
    }
  }));
  return samples;
}

/** OpenSearch's own counters, summed over nodes (all indices): what the cluster actually did. */
async function osStats() {
  const { getSearch } = await import('../server/lib/search.js');
  const res = await getSearch().nodes.stats({ metric: 'indices,os' } as never);
  const nodes = Object.values((res.body as unknown as { nodes: Record<string, {
    indices: { search: { query_total: number; query_time_in_millis: number }; get: { total: number; time_in_millis: number } };
    os: { cpu: { percent: number } };
  }> }).nodes);
  const sum = (f: (n: (typeof nodes)[number]) => number) => nodes.reduce((a, n) => a + f(n), 0);
  return {
    queries: sum((n) => n.indices.search.query_total), queryMs: sum((n) => n.indices.search.query_time_in_millis),
    gets: sum((n) => n.indices.get.total), getMs: sum((n) => n.indices.get.time_in_millis),
    cpu: Math.max(...nodes.map((n) => n.os.cpu.percent)),
  };
}

/**
 * A/B: the same polling load against the original OpenSearch-only path (?cache=off) and against
 * Valkey, stage by stage, with OpenSearch's own counters read before and after each run.
 */
async function comparePhase(ids: number[]) {
  const seconds = Number(opt('seconds', '20'));
  const rows = [];
  // Warm Valkey for every product in every city so the "after" runs measure hits, not first fills.
  for (const city of CITIES) await timed(`${BASE}/api/stock?city=${city}&ids=${ids.slice(0, 48).join(',')}`);
  for (const users of [25, 50, 100, 200]) {
    for (const mode of ['before: OpenSearch only', 'after: Valkey'] as const) {
      const cacheOff = mode.startsWith('before');
      const a = await osStats();
      const cpu: number[] = [];
      const sampler = setInterval(() => { osStats().then((x) => cpu.push(x.cpu)).catch(() => {}); }, 4000);
      const samples = await stockStage(ids, users, seconds, cacheOff);
      clearInterval(sampler);
      const b = await osStats();
      const row = {
        ...summarize(`${users} shoppers · ${mode}`, samples, seconds),
        os: {
          searchQueries: b.queries - a.queries,
          docFetches: b.gets - a.gets,
          osBusyMs: (b.queryMs - a.queryMs) + (b.getMs - a.getMs),
          cpuMaxPct: cpu.length ? Math.max(...cpu) : b.cpu,
          cpuAvgPct: cpu.length ? r1(cpu.reduce((x, y) => x + y, 0) / cpu.length) : b.cpu,
        },
      };
      console.log(JSON.stringify(row));
      rows.push(row);
      await sleep(5000); // let the cluster settle between runs
    }
  }
  return rows;
}

async function stockPhase(ids: number[]) {
  const results = [];
  for (const users of [25, 50, 100, 200]) {
    const seconds = 20;
    const samples: Sample[] = [];
    const end = Date.now() + seconds * 1000;
    await Promise.all(Array.from({ length: users }, async () => {
      await sleep(Math.random() * 1500); // browsers don't all open at the same millisecond
      const city = pick(CITIES);
      const mine = [...ids].sort(() => Math.random() - 0.5).slice(0, 12);
      while (Date.now() < end) {
        const t0 = Date.now();
        samples.push(await timed(`${BASE}/api/stock?city=${city}&ids=${mine.join(',')}`));
        await sleep(Math.max(0, 1500 - (Date.now() - t0)));
      }
    }));
    const s = summarize(`${users} shoppers polling`, samples, seconds);
    console.log(JSON.stringify(s));
    results.push(s);
  }
  return results;
}

const QUERIES = ['bluetoth earphones', 'earbuds', 'wireles speaker', 'water botle', 'travel bag', 'charger',
  'headphones', 'power bank', 'backpack', 'smart watch', 'cable', 'bottle steel', 'earfones', 'pouch'];

async function searchPhase() {
  const results = [];
  for (const users of [10, 25, 50]) {
    const seconds = 15;
    const samples: Sample[] = [];
    const tooks: number[] = [];
    const end = Date.now() + seconds * 1000;
    await Promise.all(Array.from({ length: users }, async () => {
      while (Date.now() < end) {
        const s = await timed(`${BASE}/api/search?city=${pick(CITIES)}&q=${encodeURIComponent(pick(QUERIES))}`);
        const took = (s.body as { tookMs?: number })?.tookMs;
        if (typeof took === 'number') { tooks.push(took); s.serverMs = took; }
        samples.push(s);
      }
    }));
    const s = { ...summarize(`${users} users searching`, samples, seconds), note: 'serverP* = OpenSearch tookMs' };
    console.log(JSON.stringify(s));
    results.push(s);
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
async function checkoutPhase() {
  const { withTx, getPool, closePool } = await import('../server/lib/db.js');
  const { setStock } = await import('../server/domain/stock.js');
  const { releaseOrder } = await import('../server/domain/payments.js');
  const pool = getPool();
  await pool.query('SELECT 1'); // take the slot now, before the stampede fills the database
  const SHOPPERS = 40, UNITS = 5, CITY = 'DEL';
  // A non-hero row: second product by id that isn't the AUD-001 demo item.
  const row = (await pool.query<{ product_id: number; sku: string; qty: number }>(
    `SELECT p.id AS product_id, p.sku, i.qty FROM products p JOIN inventory i ON i.product_id = p.id AND i.city_code = $1
      WHERE p.sku NOT LIKE 'AUD-001' ORDER BY p.id OFFSET 8 LIMIT 1`, [CITY])).rows[0]!;
  const runId = randomUUID().slice(0, 8);
  const startedAt = new Date(Date.now() - 1000).toISOString();
  const keys: string[] = [];
  try {
    await withTx((tx) => setStock(tx, { productId: row.product_id, city: CITY, qty: SHOPPERS, reason: 'restock' }));
    const shoppers = await Promise.all(Array.from({ length: SHOPPERS }, async (_, i) => {
      const s = await fetch(`${BASE}/api/cart?city=${CITY}`);
      const cookie = s.headers.get('set-cookie')?.split(';')[0] ?? '';
      const headers = { 'Content-Type': 'application/json', Cookie: cookie };
      const add = await fetch(`${BASE}/api/cart/items`, { method: 'POST', headers, body: JSON.stringify({ city: CITY, productId: row.product_id, qty: 1 }) });
      await add.text();
      const key = randomUUID(); keys.push(key);
      return { i, headers, key, addStatus: add.status };
    }));
    await withTx((tx) => setStock(tx, { productId: row.product_id, city: CITY, qty: UNITS, reason: 'restock' }));
    await sleep(500);

    const t0 = performance.now();
    const res = await Promise.all(shoppers.map((s) => timed(`${BASE}/api/checkout`, {
      method: 'POST', headers: s.headers,
      body: JSON.stringify({ city: CITY, customer: { name: `Load ${s.i}`, email: `load-${runId}-${s.i}@example.com` }, idempotencyKey: s.key }),
    })));
    const wallMs = performance.now() - t0;
    const statuses: Record<string, number> = {};
    for (const r of res) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    const qty = (await pool.query<{ qty: number }>('SELECT qty FROM inventory WHERE product_id=$1 AND city_code=$2', [row.product_id, CITY])).rows[0]!.qty;
    const orders = Number((await pool.query<{ n: string }>('SELECT count(*) n FROM orders WHERE idempotency_key = ANY($1::text[])', [keys])).rows[0]!.n);
    const out = {
      stage: `checkout stampede: ${SHOPPERS} shoppers, ${UNITS} units (${row.sku} ${CITY})`,
      cartAdds: shoppers.filter((s) => s.addStatus === 200).length,
      statuses, ordersInPostgres: orders, qtyAfter: qty,
      exact: orders === UNITS && qty === 0 && !Object.keys(statuses).some((s) => Number(s) >= 500 || s === '0'),
      wallMs: Math.round(wallMs), p50: r1(pct(res.map((r) => r.ms), 50)), p95: r1(pct(res.map((r) => r.ms), 95)),
    };
    console.log(JSON.stringify(out));
    return out;
  } finally {
    const pending = await pool.query<{ id: string }>(
      `SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status='pending_payment' AND c.email LIKE $1`, [`load-${runId}-%`]);
    for (const p of pending.rows) await releaseOrder(p.id, 'cancelled');
    await withTx((tx) => setStock(tx, { productId: row.product_id, city: CITY, qty: row.qty, reason: 'restock' }));
    // The losers' carts still hold the item, and cart items *claim* stock for real shoppers: clear them.
    await pool.query(
      `DELETE FROM cart_items ci USING carts c WHERE ci.cart_id = c.id AND ci.product_id = $1 AND c.city_code = $2
          AND c.status = 'active' AND c.created_at >= $3`, [row.product_id, CITY, startedAt]);
    await closePool();
  }
}

// --------------------------- doc/21: suggestions, shops, presence, together ---------------------------
const TYPED = ['phone', 'headphones', 'power bank', 'bottle', 'speaker', 'charger', 'gadget gully', 'noise cancel', 'smart watch', 'laptop'];

/** Ramp: `users` closed-loop shoppers for `seconds`, each running `act` (which records samples). */
async function ramp(label: (n: number) => string, stages: number[], seconds: number, act: (samples: Sample[], end: number) => Promise<void>) {
  const out = [];
  for (const users of stages) {
    const samples: Sample[] = [];
    const end = Date.now() + seconds * 1000;
    await Promise.all(Array.from({ length: users }, async () => { await sleep(Math.random() * 1000); await act(samples, end); }));
    const s = summarize(label(users), samples, seconds);
    console.log(JSON.stringify(s));
    out.push(s);
    await sleep(3000);
  }
  return out;
}

const tookAsServer = (s: Sample & { body?: unknown }) => {
  const took = (s.body as { tookMs?: number })?.tookMs;
  if (typeof took === 'number') s.serverMs = took;
  return s;
};

async function typeaheadPhase() {
  return ramp((n) => `${n} shoppers typing`, [10, 25, 50], 15, async (samples, end) => {
    while (Date.now() < end) {
      const word = pick(TYPED);
      const city = pick(CITIES);
      for (let i = 2; i <= word.length && Date.now() < end; i++) {
        const t0 = Date.now();
        samples.push(tookAsServer(await timed(`${BASE}/api/suggest?city=${city}&q=${encodeURIComponent(word.slice(0, i))}`)));
        await sleep(Math.max(0, 180 - (Date.now() - t0)));
      }
      await sleep(1000); // reads the dropdown, picks, then searches again
    }
  });
}

async function shopsPhase() {
  const list = (await timed(`${BASE}/api/shops`)).body as { items?: { slug: string }[] };
  const slugs = (list.items ?? []).map((s) => s.slug);
  if (!slugs.length) return null;
  const inShop = ['', '', 'hedphones', 'power bnk', 'speaker', 'bottle', 'charger', 'bag'];
  return ramp((n) => `${n} shoppers in shop storefronts`, [10, 25, 50], 15, async (samples, end) => {
    while (Date.now() < end) {
      const r = Math.random();
      const url = r < 0.15
        ? `${BASE}/api/search?city=${pick(CITIES)}&q=${encodeURIComponent(pick(['gadget gully', 'gadget gulli', 'echo and ohm']))}`
        : `${BASE}/api/shops/${pick(slugs)}?q=${encodeURIComponent(pick(inShop))}`;
      samples.push(tookAsServer(await timed(url)));
      await sleep(400 + Math.random() * 600);
    }
  });
}

async function presencePhase(ids: number[]) {
  return ramp((n) => `${n} open product pages`, [50, 100, 200], 20, async (samples, end) => {
    const city = pick(CITIES);
    const productId = pick(ids);
    while (Date.now() < end) {
      const t0 = Date.now();
      samples.push(await timed(`${BASE}/api/presence`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ city, beats: [{ productId, kind: Math.random() < 0.2 ? 'hover' : 'view' }] }),
      }));
      await sleep(Math.max(0, 5000 - (Date.now() - t0)));
    }
  });
}

async function togetherPhase(ids: number[]) {
  return ramp((n) => `${n} shoppers opening product pages`, [10, 25, 50], 15, async (samples, end) => {
    while (Date.now() < end) {
      samples.push(await timed(`${BASE}/api/together?city=${pick(CITIES)}&ids=${pick(ids)}`));
      await sleep(800 + Math.random() * 800);
    }
  });
}

// ---------------------------------------------------------------------------------------------
const health = await timed(`${BASE}/api/health`);
console.log(JSON.stringify({ target: BASE, health: health.body }));
const ids = await productIds();
console.log(JSON.stringify({ products: ids.length }));
const only = opt('only', '');
const wants = (p: string) => only === p || (only === 'new' && ['typeahead', 'shops', 'presence', 'together'].includes(p));
const report = flag('compare') ? { target: BASE, at: new Date().toISOString(), compare: await comparePhase(ids) } : only === 'new' || ['typeahead', 'shops', 'presence', 'together'].includes(only) ? {
  target: BASE, at: new Date().toISOString(),
  typeahead: wants('typeahead') ? await typeaheadPhase() : null,
  shops: wants('shops') ? await shopsPhase() : null,
  presence: wants('presence') ? await presencePhase(ids) : null,
  together: wants('together') ? await togetherPhase(ids) : null,
} : {
  target: BASE, at: new Date().toISOString(),
  stock: !only || only === 'stock' ? await stockPhase(ids) : null,
  search: !only || only === 'search' ? await searchPhase() : null,
  checkout: flag('skip-checkout') || (only && only !== 'checkout') ? null : await checkoutPhase(),
};
const { writeFileSync } = await import('node:fs');
const out = opt('out', '');
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
process.exit(0);
