import { rootCertificates } from 'node:tls';
import { Redis } from 'ioredis';
import { valkeyConfig } from '../config.js';
import { CityCode } from './http.js';
import { log, errMsg } from './log.js';

/**
 * Live-stock cache on Aiven for Valkey (doc/07 §8 S5).
 *
 * PostgreSQL stays the source of truth and OpenSearch stays the search engine. Valkey only holds
 * the hottest, smallest data: "how many of product P are on the shelf in city C, at which version".
 *
 *   key   stock:{productId}          (hash, one field per city)
 *   field BLR | MUM | DEL
 *   value "{version}|{qty}|{cityName}"
 *
 * Written by the search indexer right after OpenSearch accepts a batch (write-through), and by the
 * API when it had to fall back to OpenSearch (read-through). Every write goes through a Lua script
 * that only replaces an entry with a NEWER version, so replays, duplicates and slow readers can
 * never move stock backwards. Keys expire after VALKEY_TTL_SECONDS: a missed write heals itself.
 * Any Valkey error is logged and the caller falls back to OpenSearch; the shop never depends on it.
 */
export interface StockEntry { productId: number; city: string; cityName: string; qty: number; version: number }

const CITIES = CityCode.options;

const SET_IF_NEWER = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur then
  local v = tonumber(string.match(cur, '^(%d+)|'))
  if v and v >= tonumber(ARGV[2]) then return 0 end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return 1`;

type CacheClient = Redis & { setIfNewer(key: string, field: string, version: number, value: string, ttl: number): Promise<number> };

let client: CacheClient | null | undefined;
let lastError = 0;

export function getCache(): CacheClient | null {
  if (client !== undefined) return client;
  const cfg = valkeyConfig();
  if (!cfg) return (client = null);
  const c = new Redis(cfg.url, {
    tls: cfg.url.startsWith('rediss://') ? { ca: [...rootCertificates, ...cfg.ca] } : undefined,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false, // fail fast while disconnected → OpenSearch fallback, never a hung request
  }) as CacheClient;
  c.defineCommand('setIfNewer', { numberOfKeys: 1, lua: SET_IF_NEWER });
  c.on('error', (e) => {
    if (Date.now() - lastError > 30_000) log.warn('valkey: connection error', { err: errMsg(e) });
    lastError = Date.now();
  });
  c.on('ready', () => log.info('valkey: connected'));
  return (client = c);
}

const key = (productId: number) => `stock:${productId}`;

/** Resolve true once the client is connected (or already is), false after `ms`. */
function whenReady(c: Redis, ms: number): Promise<boolean> {
  if (c.status === 'ready') return Promise.resolve(true);
  return new Promise((resolve) => {
    const onReady = () => done(true);
    const t = setTimeout(() => done(false), ms);
    function done(ok: boolean) {
      clearTimeout(t);
      c.off('ready', onReady);
      resolve(ok);
    }
    c.once('ready', onReady);
  });
}

/**
 * Write entries (version-guarded). Never throws: the cache is an optimisation.
 *
 * Waits up to 5 s for the connection. The outage drill (doc/15) found that a freshly restarted
 * indexer's FIRST batch (the whole catch-up after an outage) arrived while the client was still
 * connecting and was skipped, so shoppers saw pre-outage stock until the TTL expired (~4 min).
 * Readers never wait (readStock falls straight back to OpenSearch); only the indexer does.
 */
export async function cacheStock(entries: StockEntry[]): Promise<void> {
  const c = getCache();
  if (!c || !entries.length) return;
  if (!(await whenReady(c, 5000))) {
    log.warn('valkey: not connected, write-through skipped (entries heal by TTL)', { entries: entries.length });
    return;
  }
  const ttl = valkeyConfig()!.ttlSeconds;
  try {
    const p = c.pipeline() as unknown as { setIfNewer: CacheClient['setIfNewer']; exec(): Promise<unknown> };
    for (const e of entries) p.setIfNewer(key(e.productId), e.city, e.version, `${e.version}|${e.qty}|${e.cityName}`, ttl);
    await p.exec();
  } catch (e) {
    log.warn('valkey: write failed', { err: errMsg(e), entries: entries.length });
  }
}

/**
 * Every city's entry for each product, or null if Valkey is unavailable or ANY product is missing a
 * city (then the caller reads OpenSearch and refills the cache).
 */
export async function readStock(productIds: number[]): Promise<Map<number, StockEntry[]> | null> {
  const c = getCache();
  if (!c || c.status !== 'ready' || !productIds.length) return null;
  try {
    const p = c.pipeline();
    for (const id of productIds) p.hgetall(key(id));
    const res = (await p.exec()) ?? [];
    const out = new Map<number, StockEntry[]>();
    for (let i = 0; i < productIds.length; i++) {
      const [err, hash] = res[i] as [Error | null, Record<string, string>];
      if (err || !hash || CITIES.some((city) => !hash[city])) return null;
      out.set(productIds[i]!, CITIES.map((city) => {
        const [v, q, ...name] = hash[city]!.split('|');
        return { productId: productIds[i]!, city, cityName: name.join('|'), qty: Number(q), version: Number(v) };
      }));
    }
    return out;
  } catch (e) {
    log.warn('valkey: read failed', { err: errMsg(e) });
    return null;
  }
}

export async function cacheHealth(): Promise<'up' | 'down' | 'off'> {
  const c = getCache();
  if (!c) return 'off';
  try {
    return (await c.ping()) === 'PONG' ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

export async function closeCache(): Promise<void> {
  if (client) await client.quit().catch(() => {});
  client = undefined;
}
