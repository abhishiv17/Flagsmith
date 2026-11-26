import { getSearch, searchIndex } from './search.js';
import { HttpError } from './http.js';
import { findShops, listShopSummaries } from './shops-index.js';
import { log, errMsg } from './log.js';
import { analyticsConfig } from '../config.js';

/**
 * Search-as-you-type (the dropdown under every search box). One OpenSearch request on the stock
 * index, using the name.sayt (search_as_you_type) field the mapping already has:
 *
 *   completions  "pho" → "phone stand", "phone holder", "phone grip": words from product names and
 *                tags that start with what's typed, after the words already typed, by how many
 *                products have them
 *   products     the best matches on the shelf in this city, with price and stock
 *   shops        partner shops whose name starts with / matches what's typed (shops index)
 *
 * Typos still find something: a fuzzy match on the name runs next to the prefix match.
 */

interface Src {
  product_id: number; sku: string; name: string; brand: string; category: string; tags?: string[];
  price_paise: number; image_key: string; qty: number; in_stock: boolean;
}

export interface Suggestions {
  q: string;
  completions: { text: string; count: number }[];
  products: { productId: number; sku: string; name: string; brand: string; category: string; pricePaise: number; imageKey: string; qty: number; inStock: boolean }[];
  categories: { key: string; count: number }[];
  shops: { slug: string; name: string; cityName: string; city: string; inStock: number; products: number }[];
  /** Empty box only: what shoppers in this city searched most this week (and found something). */
  trending?: { q: string; visitors: number }[];
  tookMs: number;
}

const SUGGEST_TIMEOUT_MS = 2000;

const STOP = new Set(['and', 'for', 'with', 'the', 'of', 'in', 'to', 'a', 'an', 'by', 'on', '&', '-', '+']);
// Hyphens split words too, so "noise c" completes "Noise-Cancelling".
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/**
 * Phrases that continue what's typed. "noise c" → "noise cancelling"; "pho" → "phone", "phone stand".
 * The typed words before the last must appear (in order, as prefixes) right before the completed word.
 */
export function completionsFrom(q: string, texts: string[], limit = 5): { text: string; count: number }[] {
  const typed = words(q);
  const partial = q.endsWith(' ') ? '' : (typed.pop() ?? '');
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const text of texts) {
    const w = words(text);
    const seen = new Set<string>();
    for (let i = typed.length; i < w.length; i++) {
      if (partial && !w[i]!.startsWith(partial)) continue;
      if (!partial && STOP.has(w[i]!)) continue;
      // The words typed before must sit right before this one (prefix match each, so "blu spe" works).
      if (!typed.every((t, j) => w[i - typed.length + j]!.startsWith(t))) continue;
      const head = [...w.slice(i - typed.length, i), w[i]!];
      const one = head.join(' ');
      if (!seen.has(one)) { seen.add(one); bump(one); }
      const next = w[i + 1];
      if (next && !STOP.has(next) && !/^\d/.test(next)) {
        const two = `${one} ${next}`;
        if (!seen.has(two)) { seen.add(two); bump(two); }
      }
    }
  }
  const typedText = [...typed, partial].join(' ').trim();
  return [...counts]
    .filter(([text]) => text !== typedText)
    // Most products first; between equals, the shorter (more general) phrase.
    .sort((a, b) => b[1] - a[1] || a[0].split(' ').length - b[0].split(' ').length || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([text, count]) => ({ text, count }));
}

export async function suggest(qRaw: string, city: string): Promise<Suggestions> {
  const t0 = Date.now();
  const q = qRaw.replace(/\s+/g, ' ').trimStart().slice(0, 60);
  const empty: Suggestions = { q, completions: [], products: [], categories: [], shops: [], tookMs: 0 };
  if (q.trim().length < 1) return { ...empty, trending: await trendingSearches(city), tookMs: Date.now() - t0 };

  // Every typed word as a prefix of some word in the name or tags ("blu spe" → Bluetooth Speaker).
  const typedWords = words(q).filter((w) => w.length >= 2).slice(0, 5);
  const everyWordPrefix = typedWords.length > 1
    ? [{ bool: { boost: 3, must: typedWords.map((w) => ({ dis_max: { queries: [{ prefix: { name: { value: w } } }, { prefix: { tags: { value: w } } }, { prefix: { brand: { value: w } } }] } })) } }]
    : [];
  const query = {
    bool: {
      filter: [{ term: { city } }],
      should: [
        ...everyWordPrefix,
        // As you type: every typed word, the last one as a prefix ("pho sta" → "Phone Stand").
        { multi_match: { query: q, type: 'bool_prefix', fields: ['name.sayt', 'name.sayt._2gram', 'name.sayt._3gram'], operator: 'and', boost: 4 } },
        // Brand and tags as prefixes too ("boa" → boAt), a little lower.
        { multi_match: { query: q, type: 'phrase_prefix', fields: ['brand', 'tags'], boost: 1.5 } },
        // Typos: "hedphones".
        { match: { name: { query: q, fuzziness: 'AUTO', prefix_length: 1, operator: 'and' } } },
      ],
      minimum_should_match: 1,
    },
  };

  const [res, shopIds] = await Promise.all([
    getSearch().search({
      index: searchIndex().alias,
      body: {
        size: 40,
        _source: ['product_id', 'sku', 'name', 'brand', 'category', 'tags', 'price_paise', 'image_key', 'qty', 'in_stock'],
        query,
        aggs: { categories: { terms: { field: 'category', size: 4 } } },
      } as never,
      // Type-ahead answers are worthless late: the shopper has typed on and the box drops stale
      // replies. Fail fast (2 s, no retry) instead of the client default 5 s × retries (doc/15 L4).
    }, { requestTimeout: SUGGEST_TIMEOUT_MS, maxRetries: 0 }).catch((e) => {
      throw new HttpError(503, 'SEARCH_UNAVAILABLE', 'Search is catching its breath. Try again in a moment.', { cause: errMsg(e) });
    }),
    q.trim().length >= 2 ? findShops(q, { prefix: true, size: 3, timeoutMs: SUGGEST_TIMEOUT_MS }).catch((e) => { log.warn('suggest: shops failed', { err: errMsg(e) }); return []; }) : Promise.resolve([]),
  ]);

  const body = res.body as unknown as {
    hits: { hits: { _source: Src }[] };
    aggregations: { categories: { buckets: { key: string; doc_count: number }[] } };
  };
  const hits = body.hits.hits.map((h) => h._source);
  const shops = shopIds.length ? await listShopSummaries(shopIds.map((s) => s.id)) : [];
  const order = new Map(shopIds.map((s, i) => [s.id, i]));

  return {
    q,
    completions: completionsFrom(q, hits.flatMap((h) => [h.name, ...(h.tags ?? [])])),
    // In stock first, keeping relevance order within each group.
    products: [...hits.filter((h) => h.in_stock), ...hits.filter((h) => !h.in_stock)].slice(0, 6).map((h) => ({
      productId: h.product_id, sku: h.sku, name: h.name, brand: h.brand, category: h.category,
      pricePaise: h.price_paise, imageKey: h.image_key, qty: h.qty, inStock: h.in_stock,
    })),
    categories: body.aggregations.categories.buckets.map((b) => ({ key: b.key, count: b.doc_count })),
    shops: shops
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map((s) => ({ slug: s.slug, name: s.name, city: s.city, cityName: s.cityName, inStock: s.inStock, products: s.products })),
    tookMs: Date.now() - t0,
  };
}

const trendCache = new Map<string, { at: number; v: Promise<{ q: string; visitors: number }[]> }>();

/**
 * Trending searches from the clickstream (doc/14's activity index in OpenSearch): the last 7 days in
 * this city, only searches that found something, ranked by how many different shoppers ran them.
 * A query is shown only once at least 2 shoppers searched it, so nobody's one-off search is broadcast.
 */
export function trendingSearches(city: string): Promise<{ q: string; visitors: number }[]> {
  const hit = trendCache.get(city);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const v = getSearch().search({
    index: analyticsConfig().index,
    body: {
      size: 0,
      query: { bool: { filter: [
        { term: { type: 'search' } }, { term: { city } }, { range: { at: { gte: 'now-7d' } } }, { range: { results: { gte: 1 } } },
      ] } },
      aggs: { q: { terms: { field: 'q', size: 40 }, aggs: { visitors: { cardinality: { field: 'visitor' } } } } },
    } as never,
  })
    .then((res) => {
      const buckets = (res.body as unknown as { aggregations: { q: { buckets: { key: string; visitors: { value: number } }[] } } }).aggregations.q.buckets;
      const merged = new Map<string, number>();
      for (const b of buckets) {
        const k = b.key.toLowerCase().replace(/\s+/g, ' ').trim();
        if (k.length < 3 || k.length > 40 || !/^[\p{L}\p{N} &'-]+$/u.test(k)) continue;
        merged.set(k, Math.max(merged.get(k) ?? 0, b.visitors.value));
      }
      const ranked = [...merged].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).slice(0, 12);
      return keepRealQueries(ranked, city);
    })
    .then((rows) => {
      // "3 in 1" and "3 in 1 charging": keep the first (more shoppers), drop the overlap.
      const out: { q: string; visitors: number }[] = [];
      for (const [q, visitors] of rows) {
        if (!out.some((o) => o.q.startsWith(q) || q.startsWith(o.q))) out.push({ q, visitors });
      }
      return out.slice(0, 6);
    })
    .catch((e) => {
      log.warn('suggest: trending failed', { err: errMsg(e) });
      trendCache.delete(city);
      return [];
    });
  trendCache.set(city, { at: Date.now(), v });
  return v;
}

/**
 * Drops test noise ("xyz qwerty"): meaning search finds *something* for anything, so a trending
 * query must also share at least one real word with a product on the shelf in this city. One msearch.
 */
async function keepRealQueries(rows: [string, number][], city: string): Promise<[string, number][]> {
  if (!rows.length) return [];
  const body = rows.flatMap(([q]) => [
    { index: searchIndex().alias },
    { size: 0, terminate_after: 1, query: { bool: { filter: [{ term: { city } }], must: [{ multi_match: { query: q, fields: ['name', 'tags', 'brand', 'description'], operator: 'or' } }] } } },
  ]);
  const res = await getSearch().msearch({ body } as never);
  const found = (res.body as unknown as { responses: { hits?: { total: { value: number } } }[] }).responses;
  return rows.filter((_, i) => (found[i]?.hits?.total.value ?? 0) > 0);
}
