import { getCache } from './cache.js';
import { log, errMsg } from './log.js';

/**
 * Who is looking at what, right now. The clickstream (doc/14) goes browser → 10 s batch → outbox →
 * Kafka → ClickHouse, which is right for history but 20-40 s behind for "live". This is the fast
 * path for the retailer dashboard's "Live now" panel:
 *
 *   the product page sends a heartbeat every 5 s while it's open and visible ("view"),
 *   a product card sends one when the pointer rests on it ("hover"), again every 4 s while it stays.
 *
 * Stored in Valkey (shared by every web instance) as one sorted set per city, member
 * "visitor|product|kind", score = last seen (ms), plus a short capped feed of moments. Without
 * Valkey (local dev, or while it's down) the same structure lives in this process's memory.
 * Visitors are the one-way hash from activity.ts: a shop sees "a shopper", never who.
 */

export type PresenceKind = 'view' | 'hover' | 'cart';
export interface PresenceBeat { productId: number; kind: PresenceKind }
export interface PresenceMoment { productId: number; kind: PresenceKind; visitor: string; at: number }

/** A heartbeat counts this long: views beat every 5 s, hovers every 4 s while the pointer stays. */
const WINDOW_MS: Record<PresenceKind, number> = { view: 15_000, hover: 8_000, cart: 60_000 };
const KEEP_MS = 60_000;
const FEED_LEN = 60;

const setKey = (city: string) => `presence:${city}`;
const feedKey = (city: string) => `presence:feed:${city}`;

/* ---------- in-process fallback ---------- */
const mem = new Map<string, Map<string, number>>();
const memFeed = new Map<string, PresenceMoment[]>();

function memWrite(city: string, visitor: string, beats: PresenceBeat[], now: number, fresh: PresenceMoment[]) {
  const set = mem.get(city) ?? new Map<string, number>();
  mem.set(city, set);
  for (const b of beats) set.set(`${visitor}|${b.productId}|${b.kind}`, now);
  for (const [k, at] of set) if (now - at > KEEP_MS) set.delete(k);
  if (fresh.length) memFeed.set(city, [...fresh, ...(memFeed.get(city) ?? [])].slice(0, FEED_LEN));
}

function parse(entries: [string, number][]): { visitor: string; productId: number; kind: PresenceKind; at: number }[] {
  return entries.map(([m, at]) => {
    const [visitor = '', id = '0', kind = 'view'] = m.split('|');
    return { visitor, productId: Number(id), kind: kind as PresenceKind, at };
  });
}

/** Record heartbeats. A beat that starts a new look (not seen in its window) also goes in the feed. */
/** Records the beats; says where they went (for Server-Timing). */
export async function notePresence(city: string, visitor: string, beats: PresenceBeat[]): Promise<'valkey' | 'memory'> {
  if (!beats.length) return 'memory';
  const now = Date.now();
  const c = getCache();
  if (c && c.status === 'ready') {
    try {
      const members = beats.map((b) => `${visitor}|${b.productId}|${b.kind}`);
      const prev = (await c.zmscore(setKey(city), ...members)) as (string | null)[];
      const fresh = beats
        .filter((b, i) => !prev[i] || now - Number(prev[i]) > WINDOW_MS[b.kind])
        .map((b) => ({ productId: b.productId, kind: b.kind, visitor, at: now }));
      const p = c.pipeline();
      p.zadd(setKey(city), ...members.flatMap((m) => [now, m]));
      p.zremrangebyscore(setKey(city), 0, now - KEEP_MS);
      p.expire(setKey(city), 300);
      if (fresh.length) {
        p.lpush(feedKey(city), ...fresh.map((f) => JSON.stringify(f)));
        p.ltrim(feedKey(city), 0, FEED_LEN - 1);
        p.expire(feedKey(city), 3600);
      }
      await p.exec();
      return 'valkey';
    } catch (e) {
      log.warn('presence: valkey write failed, using memory', { err: errMsg(e) });
    }
  }
  const set = mem.get(city);
  const fresh = beats
    .filter((b) => { const at = set?.get(`${visitor}|${b.productId}|${b.kind}`); return !at || now - at > WINDOW_MS[b.kind]; })
    .map((b) => ({ productId: b.productId, kind: b.kind, visitor, at: now }));
  memWrite(city, visitor, beats, now, fresh);
  return 'memory';
}

export interface LivePresence {
  /** Per product: distinct shoppers on its page now, and resting the pointer on its card now. */
  products: Map<number, { viewing: number; hovering: number; carting: number; lastAt: number }>;
  /** Distinct shoppers doing anything with these products now. */
  shoppers: number;
  feed: PresenceMoment[];
  source: 'valkey' | 'memory';
}

/** What's happening now in one city, limited to the given products (a shop's shelf). */
export async function livePresence(city: string, productIds: number[]): Promise<LivePresence> {
  const now = Date.now();
  const wanted = new Set(productIds);
  let entries: [string, number][] = [];
  let feed: PresenceMoment[] = [];
  let source: LivePresence['source'] = 'memory';
  const c = getCache();
  if (c && c.status === 'ready') {
    try {
      const p = c.pipeline();
      p.zrangebyscore(setKey(city), now - KEEP_MS, '+inf', 'WITHSCORES');
      p.lrange(feedKey(city), 0, FEED_LEN - 1);
      const [[e1, flat], [e2, list]] = (await p.exec()) as [[Error | null, string[]], [Error | null, string[]]];
      if (e1 || e2) throw e1 ?? e2;
      for (let i = 0; i < flat.length; i += 2) entries.push([flat[i]!, Number(flat[i + 1])]);
      feed = list.map((s) => JSON.parse(s) as PresenceMoment);
      source = 'valkey';
    } catch (e) {
      log.warn('presence: valkey read failed, using memory', { err: errMsg(e) });
      entries = [];
    }
  }
  if (source === 'memory') {
    entries = [...(mem.get(city) ?? new Map<string, number>())];
    feed = memFeed.get(city) ?? [];
  }

  const products = new Map<number, { viewing: number; hovering: number; carting: number; lastAt: number }>();
  const sets = new Map<number, { view: Set<string>; hover: Set<string>; cart: Set<string>; lastAt: number }>();
  const shoppers = new Set<string>();
  for (const e of parse(entries)) {
    if (!wanted.has(e.productId) || now - e.at > WINDOW_MS[e.kind]) continue;
    const s = sets.get(e.productId) ?? { view: new Set(), hover: new Set(), cart: new Set(), lastAt: 0 };
    s[e.kind].add(e.visitor);
    s.lastAt = Math.max(s.lastAt, e.at);
    sets.set(e.productId, s);
    shoppers.add(e.visitor);
  }
  for (const [id, s] of sets) products.set(id, { viewing: s.view.size, hovering: s.hover.size, carting: s.cart.size, lastAt: s.lastAt });
  return { products, shoppers: shoppers.size, feed: feed.filter((f) => wanted.has(f.productId)).slice(0, 20), source };
}
