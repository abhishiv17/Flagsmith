import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { rootCertificates } from 'node:tls';
import { clickhouseConfig } from '../config.js';

/**
 * Minimal Aiven for ClickHouse client over the HTTPS interface (no extra dependency).
 *
 * ClickHouse holds the retailer's customer analytics (doc/16): every order line and every shopper
 * click, fed from Kafka by the clickhouse worker. PostgreSQL stays the source of truth for stock,
 * orders and coupons; ClickHouse answers "who buys most, who browses most, what converts".
 *
 * Queries use ClickHouse's own parameter binding ({name:Type} + param_name=…), never string pasting.
 */
export class ClickHouseError extends Error {}

export const chEnabled = () => clickhouseConfig() !== null;

/**
 * The HTTPS port to use. Aiven App Runtime's "Connect service" injects the NATIVE protocol port
 * (e.g. 26527); ClickHouse answers HTTP there with "You must use port 26528 for HTTP". We take the
 * port from that answer once and keep it. CLICKHOUSE_HTTPS_PORT overrides both.
 */
let httpPort: string | null = process.env.CLICKHOUSE_HTTPS_PORT ?? null;
const PORT_HINT = /must use port (\d{2,5}) for HTTP/i;

async function call(sql: string, params: Record<string, string | number> = {}, body?: string, useDb = true): Promise<string> {
  try {
    return await callOnce(sql, params, body, useDb);
  } catch (e) {
    const hint = e instanceof ClickHouseError ? PORT_HINT.exec(e.message) : null;
    if (!hint || hint[1] === httpPort) throw e;
    httpPort = hint[1]!;
    return callOnce(sql, params, body, useDb);
  }
}

function callOnce(sql: string, params: Record<string, string | number>, body: string | undefined, useDb: boolean): Promise<string> {
  const cfg = clickhouseConfig();
  if (!cfg) return Promise.reject(new ClickHouseError('ClickHouse is not configured'));
  const qs = new URLSearchParams({ query: sql });
  if (useDb) qs.set('database', cfg.database);
  for (const [k, v] of Object.entries(params)) qs.set(`param_${k}`, String(v));
  const auth = Buffer.from(`${decodeURIComponent(cfg.url.username)}:${decodeURIComponent(cfg.url.password)}`).toString('base64');
  const isHttps = cfg.url.protocol === 'https:';
  const opts = {
    hostname: cfg.url.hostname,
    port: httpPort ?? (cfg.url.port || (isHttps ? 443 : 80)),
    path: `/?${qs}`,
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'text/plain; charset=utf-8' },
    timeout: 15_000,
    ...(isHttps ? { ca: [...rootCertificates, ...cfg.ca] } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = (isHttps ? request : httpRequest)(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 300) reject(new ClickHouseError(data.slice(0, 500).trim() || `HTTP ${res.statusCode}`));
        else resolve(data);
      });
    });
    req.on('timeout', () => req.destroy(new ClickHouseError('ClickHouse request timed out')));
    req.on('error', reject);
    req.end(body ?? '');
  });
}

/** Run a statement that returns nothing (DDL). */
export async function chExec(sql: string, params?: Record<string, string | number>): Promise<void> {
  await call(sql, params);
}

/** Run a SELECT and return its rows as objects. */
export async function chQuery<T>(sql: string, params?: Record<string, string | number>): Promise<T[]> {
  const out = await call(`${sql}\nFORMAT JSON`, params);
  return (JSON.parse(out) as { data: T[] }).data;
}

/** SELECT plus ClickHouse's own statistics (shown on the retailer dashboard as "answered in N ms"). */
export async function chSelect<T>(sql: string, params?: Record<string, string | number>) {
  const out = JSON.parse(await call(`${sql}\nFORMAT JSON`, params)) as {
    data: T[]; statistics?: { elapsed: number; rows_read: number; bytes_read: number };
  };
  return { rows: out.data, ms: (out.statistics?.elapsed ?? 0) * 1000, rowsRead: out.statistics?.rows_read ?? 0 };
}

/** Insert rows (JSONEachRow). Empty input is a no-op. */
export async function chInsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.length) return;
  await call(`INSERT INTO ${table} FORMAT JSONEachRow`, {}, rows.map((r) => JSON.stringify(r)).join('\n'));
}

/** Database and tables, created on first use (idempotent). */
let ready: Promise<void> | null = null;
export function ensureSchema(): Promise<void> {
  ready ??= (async () => {
    const db = clickhouseConfig()!.database;
    // Database first (connect to "default" for this one statement).
    if (!/^[a-z_][a-z0-9_]*$/i.test(db)) throw new ClickHouseError(`Bad database name ${db}`);
    await call(`CREATE DATABASE IF NOT EXISTS ${db}`, {}, undefined, false);
    for (const ddl of SCHEMA) await chExec(ddl);
  })().catch((e) => {
    ready = null; // retry next time
    throw e;
  });
  return ready;
}

/**
 * ReplacingMergeTree + FINAL in queries = idempotent: Kafka redelivery or a re-run of the seed
 * replaces rows instead of double-counting. `source` is 'live' (from Kafka) or 'demo' (seeded
 * history, scripts/seed-clickhouse.ts) so the dashboard can show or hide demo data.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS orders (
     order_id String, at DateTime64(3, 'UTC'), order_number String, city LowCardinality(String),
     customer_email String, customer_name String, visitor String,
     total_paise UInt64, discount_paise UInt64 DEFAULT 0, coupon String DEFAULT '', items UInt16,
     source LowCardinality(String) DEFAULT 'live'
   ) ENGINE = ReplacingMergeTree ORDER BY order_id`,
  `CREATE TABLE IF NOT EXISTS order_lines (
     order_id String, product_id UInt32, at DateTime64(3, 'UTC'), city LowCardinality(String),
     customer_email String, name String, qty UInt16, unit_price_paise UInt32, seller String DEFAULT '',
     source LowCardinality(String) DEFAULT 'live'
   ) ENGINE = ReplacingMergeTree ORDER BY (order_id, product_id)`,
  // Which partner shop sold the line (doc/18); 0 = StockHop's own store. Added after launch.
  `ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS seller_id UInt32 DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS activity (
     event_id UInt64, at DateTime64(3, 'UTC'), type LowCardinality(String), visitor String,
     city LowCardinality(String), page String, label String, product_id UInt32, q String,
     source LowCardinality(String) DEFAULT 'live'
   ) ENGINE = ReplacingMergeTree ORDER BY (source, event_id)`,
];
