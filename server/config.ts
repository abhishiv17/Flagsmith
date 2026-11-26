import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * All configuration comes from environment variables (brief ground rule: no secrets in the repo).
 * Each service's config is validated lazily, so the web container (PG + OpenSearch only) doesn't
 * need Kafka credentials, and workers don't need anything they don't use.
 * Aiven Runtime injects its own names (OPENSEARCH_URI, KAFKA_BOOTSTRAP_SERVERS, KAFKA_ACCESS_*);
 * both naming schemes are accepted.
 */
const raw = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    ADMIN_TOKEN: z.string().optional(),
    LOW_STOCK_THRESHOLD: z.coerce.number().int().nonnegative().default(2),
    /** How long checkout holds stock while the shopper pays (Razorpay). Unpaid holds are released after this. */
    RESERVATION_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
    /** How long a cart's claim on units lasts after its last activity (add / change). */
    CART_CLAIM_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
    /**
     * Test switches, default on. scripts/concurrency-suite.ts turns both off IN ITS OWN PROCESS to
     * stress checkout allocation itself (claims would stop the traffic at Add to cart; pay-then-confirm
     * would hold orders as pending). Never set these on a deployed service.
     */
    CART_CLAIMS: z.enum(['on', 'off']).default('on'),
    CHECKOUT_PAYMENTS: z.enum(['on', 'off']).default('on'),
    /**
     * Accounts (doc/17). Email delivery is simulated (like order confirmations), so by default the
     * sign-in code is shown on screen, labelled as a demo. Set to "false" once a real email sender exists.
     */
    AUTH_DEMO_CODES: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    /** Optional pepper for sign-in code hashes. */
    AUTH_SECRET: z.string().optional(),
    /** Loyalty coupons only redeem for a shopper signed in with the coupon's email (proves they own it). */
    COUPON_REQUIRES_SIGN_IN: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

    DATABASE_URL: z.string().optional(),
    PG_CA_CERT: z.string().optional(),
    PG_CA_PATH: z.string().optional(),
    PG_POOL_MAX: z.coerce.number().int().positive().default(5),
    // Aiven free PG has 15 connections (12 usable) shared by Vercel, workers and laptops:
    // close idle sockets quickly and fail fast (→ 503 BUSY) instead of hanging when it's full.
    PG_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    PG_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

    KAFKA_BROKER: z.string().optional(),
    KAFKA_BOOTSTRAP_SERVERS: z.string().optional(), // Aiven Runtime integration name
    KAFKA_CA_CERT: z.string().optional(),
    KAFKA_CA_PATH: z.string().optional(),
    KAFKA_ACCESS_CERT: z.string().optional(),
    KAFKA_CERT_PATH: z.string().optional(),
    KAFKA_ACCESS_KEY: z.string().optional(),
    KAFKA_KEY_PATH: z.string().optional(),
    KAFKA_SASL_USERNAME: z.string().optional(),
    KAFKA_SASL_PASSWORD: z.string().optional(),
    KAFKA_SASL_MECHANISM: z.enum(['scram-sha-256', 'scram-sha-512', 'plain']).default('scram-sha-256'),
    KAFKA_CLIENT_ID: z.string().default('stockhop'),
    TOPIC_ORDERS: z.string().default('orders.placed'),
    TOPIC_INVENTORY: z.string().default('inventory.changed'),
    TOPIC_SMOKE: z.string().default('smoke'),
    /** Shopper clickstream (page views, clicks, searches). Written via the outbox, so the API needs no Kafka access. */
    TOPIC_ACTIVITY: z.string().default('user.activity'),
    OPENSEARCH_ACTIVITY_INDEX: z.string().default('stockhop-activity'),

    // Valkey (live-stock cache). Optional: without it /api/stock reads OpenSearch as before.
    VALKEY_URL: z.string().optional(),
    VALKEY_URI: z.string().optional(), // Aiven Runtime integration name
    REDIS_URL: z.string().optional(),
    VALKEY_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    // Aiven for ClickHouse (retailer customer analytics, doc/16). HTTPS URL with credentials.
    CLICKHOUSE_URL: z.string().optional(),
    CLICKHOUSE_URI: z.string().optional(),
    CLICKHOUSE_HTTPS_URL: z.string().optional(),
    CLICKHOUSE_DATABASE: z.string().default('stockhop'),
    // Aiven App Runtime "Connect service" injects these instead of one URI (doc/16).
    CLICKHOUSE_HOST: z.string().optional(),
    CLICKHOUSE_PORT: z.string().optional(),
    CLICKHOUSE_USER: z.string().optional(),
    CLICKHOUSE_PASSWORD: z.string().optional(),
    CLICKHOUSE_SECURE: z.string().optional(),
    COUPON_PERCENT_MAX: z.coerce.number().int().min(1).max(90).default(30),

    OPENSEARCH_URL: z.string().optional(),
    OPENSEARCH_URI: z.string().optional(), // Aiven Runtime integration name
    OPENSEARCH_INDEX_ALIAS: z.string().default('products'),
    OPENSEARCH_INDEX_NAME: z.string().default('products_v9'),
    test_api_key: z.string().optional(),
    test_key_secret: z.string().optional(),
  })
  .parse(process.env);

export const env = raw;

function required(name: keyof typeof raw): string {
  const v = raw[name];
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var ${String(name)}. See .env.example and doc/10-aiven-setup.md`);
  }
  return String(v);
}

/** First non-empty value among env vars (our names first, then Aiven Runtime's injected names). */
function first(...names: (keyof typeof raw)[]): string | undefined {
  for (const n of names) {
    const v = raw[n];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

/**
 * PEM from env content (hosted: Aiven Runtime) or a file path (local).
 * Content vars may hold PEM text (real or escaped "\n" newlines) or a path to a PEM file.
 */
function pem(contentVars: (keyof typeof raw)[], pathVar: keyof typeof raw): string {
  const inline = first(...contentVars);
  if (inline) {
    if (inline.includes('-----BEGIN')) return inline.replace(/\\n/g, '\n');
    if (existsSync(inline)) return readFileSync(inline, 'utf8');
  }
  const path = first(pathVar);
  if (path) return readFileSync(path, 'utf8');
  throw new Error(`Missing ${contentVars.join(' / ')} or ${String(pathVar)}. See .env.example`);
}

export function pgConfig() {
  // node-pg: an explicit `ssl` object conflicts with ?sslmode= in the URI, so strip it.
  const url = new URL(required('DATABASE_URL'));
  url.searchParams.delete('sslmode');
  return {
    connectionString: url.toString(),
    // Aiven uses one CA per project, so the Kafka CA (injected by Runtime) also verifies PostgreSQL.
    ssl: { ca: pem(['PG_CA_CERT', 'KAFKA_CA_CERT'], 'PG_CA_PATH'), rejectUnauthorized: true },
    max: raw.PG_POOL_MAX,
    idleTimeoutMillis: raw.PG_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: raw.PG_CONNECT_TIMEOUT_MS,
  };
}

/**
 * Aiven Kafka auth: SASL/SCRAM over TLS (Aiven console default) when KAFKA_SASL_USERNAME is set,
 * otherwise mTLS client certificate. Note: Aiven exposes different ports for each method.
 */
export function kafkaConfig() {
  const ca = [pem(['KAFKA_CA_CERT'], 'KAFKA_CA_PATH')];
  const topics = { orders: raw.TOPIC_ORDERS, inventory: raw.TOPIC_INVENTORY, smoke: raw.TOPIC_SMOKE, activity: raw.TOPIC_ACTIVITY };
  const brokers = first('KAFKA_BROKER', 'KAFKA_BOOTSTRAP_SERVERS')?.split(',').map((b) => b.trim()).filter(Boolean);
  if (!brokers?.length) throw new Error('Missing KAFKA_BROKER (or KAFKA_BOOTSTRAP_SERVERS). See .env.example');
  const base = { clientId: raw.KAFKA_CLIENT_ID, brokers, topics };

  if (raw.KAFKA_SASL_USERNAME) {
    return {
      ...base,
      ssl: { ca, rejectUnauthorized: true },
      sasl: {
        mechanism: raw.KAFKA_SASL_MECHANISM,
        username: raw.KAFKA_SASL_USERNAME,
        password: required('KAFKA_SASL_PASSWORD'),
      } as const,
    };
  }
  return {
    ...base,
    ssl: {
      ca,
      cert: pem(['KAFKA_ACCESS_CERT'], 'KAFKA_CERT_PATH'),
      key: pem(['KAFKA_ACCESS_KEY'], 'KAFKA_KEY_PATH'),
      rejectUnauthorized: true,
    },
    sasl: undefined,
  };
}

export function searchConfig() {
  return {
    node: (() => {
      const url = first('OPENSEARCH_URL', 'OPENSEARCH_URI');
      if (!url) throw new Error('Missing OPENSEARCH_URL (or OPENSEARCH_URI). See .env.example');
      return url;
    })(),
    alias: raw.OPENSEARCH_INDEX_ALIAS,
    indexName: raw.OPENSEARCH_INDEX_NAME,
  };
}

/** Analytics: Kafka topic for shopper activity and the OpenSearch index the analytics worker writes. */
export function analyticsConfig() {
  return { topic: raw.TOPIC_ACTIVITY, index: raw.OPENSEARCH_ACTIVITY_INDEX };
}

/**
 * Valkey (live-stock cache). Returns null when not configured: callers then use OpenSearch.
 * TLS trusts the public roots plus the Aiven project CA (whichever one signed the server cert).
 */
/** Aiven for ClickHouse over HTTPS; null when not configured (the retailer dashboard then says so). */
export function clickhouseConfig(): { url: URL; ca: string[]; database: string } | null {
  let u = first('CLICKHOUSE_URL', 'CLICKHOUSE_HTTPS_URL', 'CLICKHOUSE_URI');
  if ((!u || !/^https?:\/\//.test(u)) && raw.CLICKHOUSE_HOST && raw.CLICKHOUSE_USER && raw.CLICKHOUSE_PASSWORD) {
    // Built from the parts Aiven App Runtime "Connect service" injects (HTTPS interface port + "secure").
    const scheme = /^(0|false|no)$/i.test(raw.CLICKHOUSE_SECURE ?? '') ? 'http' : 'https';
    const port = raw.CLICKHOUSE_PORT ? `:${raw.CLICKHOUSE_PORT}` : '';
    u = `${scheme}://${encodeURIComponent(raw.CLICKHOUSE_USER)}:${encodeURIComponent(raw.CLICKHOUSE_PASSWORD)}@${raw.CLICKHOUSE_HOST}${port}`;
  }
  if (!u || !/^https?:\/\//.test(u)) return null;
  const ca: string[] = [];
  const projectCa = first('PG_CA_CERT', 'KAFKA_CA_CERT');
  if (projectCa?.includes('-----BEGIN')) ca.push(projectCa.replace(/\\n/g, '\n'));
  else if (raw.PG_CA_PATH && existsSync(raw.PG_CA_PATH)) ca.push(readFileSync(raw.PG_CA_PATH, 'utf8'));
  return { url: new URL(u), ca, database: raw.CLICKHOUSE_DATABASE };
}

export function valkeyConfig(): { url: string; ca: string[]; ttlSeconds: number } | null {
  const url = first('VALKEY_URL', 'VALKEY_URI', 'REDIS_URL');
  if (!url) return null;
  const ca: string[] = [];
  const projectCa = first('PG_CA_CERT', 'KAFKA_CA_CERT');
  if (projectCa?.includes('-----BEGIN')) ca.push(projectCa.replace(/\\n/g, '\n'));
  else if (raw.PG_CA_PATH && existsSync(raw.PG_CA_PATH)) ca.push(readFileSync(raw.PG_CA_PATH, 'utf8'));
  return { url, ca, ttlSeconds: raw.VALKEY_TTL_SECONDS };
}
