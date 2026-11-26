import { getSearch, searchIndex } from './search.js';
import { docId } from './events.js';
import { CityCode, HttpError } from './http.js';
import { cacheStock, readStock, type StockEntry } from './cache.js';
import { parseIntent } from './query-intent.js';
import { catalogScores } from './catalog-index.js';
import { log } from './log.js';
import { USES, type Use } from '../db/catalogue-details.js';

/** Search, live-stock and "nearby" queries against OpenSearch (doc/04 §3). */

export interface SearchParams {
  q?: string;
  city: string;
  category?: string;
  minPrice?: number;
  maxPrice?: number;
  inStock?: boolean;
  /** "Good for" facet: hard filter on one occasion. */
  use?: string;
  /** Chips the shopper removed: price, stock, city, cheap, use:<key>. */
  ignore?: string[];
  /** doc/19 facets: colour, connectivity, water rating, minimum battery hours. */
  colour?: string;
  conn?: string;
  water?: string;
  battery?: number;
  /** Shopper's sort; relevance (default) keeps in-stock first, then best match. */
  sort?: SearchSort;
  page: number;
  size: number;
}

interface Src {
  product_id: number; sku: string; name: string; brand: string; category: string;
  price_paise: number; image_key: string; city: string; city_name: string;
  qty: number; in_stock: boolean; stock_version: number; uses?: string[];
  colour?: string; connectivity?: string[]; water_rating?: string; battery_hours?: number;
}

export type SearchSort = 'relevance' | 'price_asc' | 'price_desc' | 'stock' | 'name';

/** An explicit sort from the shopper, as OpenSearch sort clauses (null = relevance). */
function explicitSort(sort: SearchSort | undefined): object[] | null {
  switch (sort) {
    case 'price_asc': return [{ in_stock: 'desc' }, { price_paise: 'asc' }, { 'name.kw': 'asc' }];
    case 'price_desc': return [{ in_stock: 'desc' }, { price_paise: 'desc' }, { 'name.kw': 'asc' }];
    case 'stock': return [{ qty: 'desc' }, { 'name.kw': 'asc' }];
    case 'name': return [{ 'name.kw': 'asc' }];
    default: return null;
  }
}

export interface Nearby { city: string; cityName: string; qty: number }

export interface SearchItem {
  productId: number; sku: string; name: string; brand: string; category: string;
  pricePaise: number; imageKey: string; city: string; qty: number; inStock: boolean;
  stockVersion: number; nearby: Nearby | null;
}

// doc/19: the whole product page is searchable: highlights, about, specs, in the box.
const FIELDS = ['name^3', 'tags^2', 'brand^2', 'features^1.5', 'description', 'about', 'specs_text', 'in_box^0.5'];

function toItem(s: Src, nearby: Map<number, Nearby>): SearchItem {
  return {
    productId: s.product_id, sku: s.sku, name: s.name, brand: s.brand, category: s.category,
    pricePaise: s.price_paise, imageKey: s.image_key, city: s.city, qty: s.qty,
    inStock: s.in_stock, stockVersion: s.stock_version,
    nearby: s.in_stock ? null : (nearby.get(s.product_id) ?? null),
  };
}

/** Wrap OpenSearch failures as 503 so the UI can show a friendly message. */
async function os<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new HttpError(503, 'SEARCH_UNAVAILABLE', 'Search is catching its breath. Try again in a moment.', {
      cause: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function searchProducts(p: SearchParams) {
  const raw = p.q?.trim();
  // Search like you talk (doc/19): price, stock, city and occasions come out of the sentence.
  const ignore = new Set(p.ignore ?? []);
  const intent = raw ? parseIntent(raw) : null;
  const uses = (intent?.uses ?? []).filter((u) => !ignore.has(`use:${u}`));
  const expand = (intent?.expand ?? []).filter((e) => !ignore.has(e.key));
  const text = intent?.text ?? '';
  // "Gift for dad": leave kids' products out, unless the shopper removed who it's for.
  const adultsOnly = Boolean(intent?.adultsOnly) && expand.some((e) => e.key.startsWith('for:'));
  const city = intent?.city && !ignore.has('city') ? intent.city : p.city;
  const minPrice = p.minPrice ?? (ignore.has('price') ? undefined : intent?.minPrice);
  const maxPrice = p.maxPrice ?? (ignore.has('price') ? undefined : intent?.maxPrice);
  const inStock = p.inStock || (intent?.inStock && !ignore.has('stock'));
  const cheapestFirst = intent?.cheapestFirst && !ignore.has('cheap');

  const should: object[] = [];
  if (text) {
    // Two clauses: synonyms (exact) and typos (fuzzy). They don't combine reliably in one.
    should.push(
      // Most words must match in one field ("laptop bag" needs both); loosening step 2 relaxes this.
      { multi_match: { query: text, fields: FIELDS, analyzer: 'product_text_syn', boost: 2, minimum_should_match: '2<75%' } },
      // Typo clause: every word (up to 2) must hit the same field, so "bluetoth earphones" ranks
      // Bluetooth earphones above wired ones that only share "earphones".
      { multi_match: { query: text, fields: FIELDS, analyzer: 'product_text', fuzziness: 'AUTO', prefix_length: 1, minimum_should_match: '2<75%' } },
    );
  }
  // What it IS beats what it MENTIONS: "earphones" ranks earphones above a charger that charges them.
  if (text) should.push({ multi_match: { query: text, fields: ['name^2', 'tags'], analyzer: 'product_text', fuzziness: 'AUTO', prefix_length: 1, minimum_should_match: '2<75%', boost: 4 } });
  // "For my commute": products tagged for that occasion rank first, without hiding the rest.
  // Gifting is a nudge when the shopper named the thing ("earbuds for my boyfriend"): earbuds first.
  const occasions = uses.filter((u) => u !== 'gift' || !text);
  if (occasions.length) should.push({ terms: { uses: occasions, boost: 3 } });
  if (text && uses.includes('gift')) should.push({ term: { uses: { value: 'gift', boost: 0.5 } } });
  // What the sentence implies: who it's for, what problem it solves (query-intent.ts).
  for (const e of expand) should.push({ multi_match: { query: e.terms, fields: FIELDS, analyzer: 'product_text_syn', boost: e.boost } });
  // A sentence with nothing searchable in it ("something nice"): popular picks, gifts first.
  const popular = [{ bool: { should: [{ terms: { uses: ['gift'], boost: 2 } }, { match_all: {} }] } }];
  const must: object[] = should.length ? [{ bool: { should, minimum_should_match: 1 } }] : raw ? popular : [{ match_all: {} }];
  const mustNot: object[] = adultsOnly ? [{ match_phrase: { name: 'kids' } }] : [];
  // "Cheap power bank": sorted by price, so only keep results that are actually power banks.
  if (cheapestFirst && text) {
    // ...by what it IS (name/tags), not what it mentions (a fan "you can plug into a power bank").
    must.push({ multi_match: { query: text, fields: ['name^2', 'tags'], analyzer: 'product_text_syn', type: 'cross_fields', operator: 'and' } });
  }

  const filter: object[] = [{ term: { city } }];
  if (minPrice !== undefined || maxPrice !== undefined) filter.push({ range: { price_paise: { gte: minPrice, lte: maxPrice } } });
  if (inStock) filter.push({ term: { in_stock: true } });
  // "Only 1 left", "last one", "few left": items on their last units.
  const maxLeft = ignore.has('left') ? undefined : intent?.maxLeft;
  if (maxLeft) filter.push({ range: { qty: { gte: 1, lte: maxLeft } } });
  // doc/19: colour and battery from the sentence or the facet; connectivity and water as facets.
  const colour = p.colour ?? (ignore.has('colour') ? undefined : intent?.colour);
  const minBattery = p.battery ?? (ignore.has('battery') ? undefined : intent?.minBatteryHours);
  if (colour) filter.push({ term: { colour } });
  if (minBattery) filter.push({ range: { battery_hours: { gte: minBattery } } });
  const post: object[] = [];
  if (p.conn) post.push({ term: { connectivity: p.conn } });
  if (p.water) post.push({ term: { water_rating: p.water } });
  if (p.category) post.push({ term: { category: p.category } });
  if (p.use) post.push({ term: { uses: p.use } });

  const body = (q: { must: object[]; mustNot: object[]; filter: object[]; byScore: boolean }) => ({
    from: (p.page - 1) * p.size,
    size: p.size,
    track_total_hits: true,
    query: { bool: { must: q.must, must_not: q.mustNot, filter: q.filter } },
    // Facet filters as post_filter so each facet still shows every option's count.
    ...(post.length ? { post_filter: { bool: { filter: post } } } : {}),
    sort: explicitSort(p.sort) ?? (cheapestFirst
      ? [{ in_stock: 'desc' }, { price_paise: 'asc' }]
      : q.byScore
        ? [{ in_stock: 'desc' }, '_score', { price_paise: 'asc' }]
        : [{ in_stock: 'desc' }, { 'name.kw': 'asc' }]),
    // Why did this match? Shown under each result.
    ...(text
      ? { highlight: { pre_tags: ['[['], post_tags: [']]'], fields: { features: { number_of_fragments: 1, fragment_size: 90 }, specs_text: { number_of_fragments: 1, fragment_size: 70 }, description: { number_of_fragments: 1, fragment_size: 110 } } } }
      : {}),
    aggs: {
      categories: { terms: { field: 'category', size: 20 } },
      uses: { terms: { field: 'uses', size: 20 } },
      colours: { terms: { field: 'colour', size: 20 } },
      connectivity: { terms: { field: 'connectivity', size: 12, exclude: 'none' } },
      water: { terms: { field: 'water_rating', size: 12, exclude: 'none' } },
      battery: { range: { field: 'battery_hours', ranges: [{ key: '8', from: 8 }, { key: '20', from: 20 }, { key: '30', from: 30 }, { key: '168', from: 168 }] } },
      price_bands: {
        range: {
          field: 'price_paise',
          ranges: [
            { key: 'under-500', to: 50000 },
            { key: '500-1500', from: 50000, to: 150000 },
            { key: '1500-3000', from: 150000, to: 300000 },
            { key: '3000-plus', from: 300000 },
          ],
        },
      },
    },
  });

  const corrected = intent?.corrected ? `Showing results for “${intent.corrected}”.` : undefined;
  const understood = intent ? intent.understood.filter((c) => !ignore.has(c.key)) : [];

  // Keywords + meaning (doc/19). Falls through to keywords only when the meaning index or the
  // model isn't available, or nothing matched (then the loosening steps below take over).
  if (raw && intent) {
    const started = Date.now();
    const hybrid = await hybridSearch({
      p, city, text, semanticText: intent.semanticText, uses, must: should.length ? must : [], mustNot, filter, cheapestFirst: Boolean(cheapestFirst),
    }).catch((e) => { log.warn('search: meaning path failed, keywords only', { err: e instanceof Error ? e.message : String(e) }); return null; });
    if (hybrid) {
      const nearby = await nearbyFor(hybrid.page.filter((h) => !h.src.in_stock).map((h) => h.src.product_id), city);
      return {
        tookMs: Date.now() - started,
        total: hybrid.total,
        city,
        items: hybrid.page.map((h) => ({ ...toItem(h.src, nearby), why: h.why })),
        intent: { understood, text, notice: corrected },
        facets: hybrid.facets,
      };
    }
  }

  // Never a dead end: if nothing matches, loosen step by step and say so.
  //  1. what the shopper asked · 2. any one of their words, typos allowed · 3. what the sentence
  //  implied (who it's for, occasions) without their exact words · 4. popular picks on the shelf.
  const anyWord = text
    ? [{ multi_match: { query: text, fields: FIELDS, analyzer: 'product_text', fuzziness: 'AUTO', prefix_length: 1, operator: 'or' } }]
    : [];
  const implied = [...(uses.length ? [{ terms: { uses, boost: 3 } }] : []),
    ...expand.map((e) => ({ multi_match: { query: e.terms, fields: FIELDS, analyzer: 'product_text_syn', boost: e.boost } }))];
  const attempts: { must: object[]; mustNot: object[]; filter: object[]; byScore: boolean; notice?: string }[] = [
    { must, mustNot, filter, byScore: should.length > 0 || Boolean(raw) },
  ];
  if (raw) {
    const shown = `No exact match for “${raw}”.`;
    if (anyWord.length) attempts.push({ must: [{ bool: { should: [...anyWord, ...implied], minimum_should_match: 1 } }], mustNot, filter, byScore: true, notice: `${shown} Showing the closest matches.` });
    if (implied.length) attempts.push({ must: [{ bool: { should: implied, minimum_should_match: 1 } }], mustNot, filter, byScore: true, notice: `${shown} Showing what fits what you described.` });
    attempts.push({ must: popular, mustNot, filter, byScore: true, notice: `${shown} Here are popular picks in stock instead.` });
    if (minPrice !== undefined || maxPrice !== undefined || inStock) {
      attempts.push({ must: popular, mustNot, filter: [{ term: { city } }], byScore: true, notice: `${shown} Nothing at that price or in stock, so here are popular picks.` });
    }
  }
  let res!: { body: unknown };
  let notice: string | undefined;
  for (const a of attempts) {
    res = await os(() => getSearch().search({ index: searchIndex().alias, body: body(a) as never }));
    notice = a.notice;
    if ((res.body as unknown as { hits: { total: { value: number } } }).hits.total.value > 0) break;
  }
  const r = res.body as unknown as {
    took: number;
    hits: { total: { value: number }; hits: { _source: Src; highlight?: Record<string, string[]> }[] };
    aggregations: {
      categories: { buckets: { key: string; doc_count: number }[] };
      uses: { buckets: { key: string; doc_count: number }[] };
      colours: { buckets: { key: string; doc_count: number }[] };
      connectivity: { buckets: { key: string; doc_count: number }[] };
      water: { buckets: { key: string; doc_count: number }[] };
      battery: { buckets: { key: string; doc_count: number }[] };
      price_bands: { buckets: { key: string; doc_count: number }[] };
    };
  };
  const sources = r.hits.hits.map((h) => h._source);
  const nearby = await nearbyFor(sources.filter((s) => !s.in_stock).map((s) => s.product_id), city);

  return {
    tookMs: r.took,
    total: r.hits.total.value,
    city,
    items: r.hits.hits.map((h) => ({ ...toItem(h._source, nearby), why: whyMatched(h._source, h.highlight, uses) })),
    intent: intent ? { understood, text, notice: notice ?? corrected } : null,
    facets: {
      categories: r.aggregations.categories.buckets.map((b) => ({ key: b.key, count: b.doc_count })),
      uses: r.aggregations.uses.buckets.map((b) => ({ key: b.key, label: USES[b.key as Use] ?? b.key, count: b.doc_count })),
      priceBands: r.aggregations.price_bands.buckets.map((b) => ({ key: b.key, count: b.doc_count })),
      colours: r.aggregations.colours.buckets.map((b) => ({ key: b.key, count: b.doc_count })),
      connectivity: r.aggregations.connectivity.buckets.map((b) => ({ key: b.key, count: b.doc_count })),
      water: r.aggregations.water.buckets.map((b) => ({ key: b.key, count: b.doc_count })),
      battery: r.aggregations.battery.buckets.filter((b) => b.doc_count > 0).map((b) => ({ key: b.key, count: b.doc_count })),
    },
  };
}

const PRICE_BANDS = [
  { key: 'under-500', to: 50000 },
  { key: '500-1500', from: 50000, to: 150000 },
  { key: '1500-3000', from: 150000, to: 300000 },
  { key: '3000-plus', from: 300000 },
];

/**
 * Hybrid ranking (doc/19). Three signals per product, each scaled 0..1 against the best in this search:
 *   keywords  the stock index query: names, tags, features, typos, synonyms, plus what the parser
 *             understood (who it's for, needs, occasions)                                      × 0.5
 *   about     full-text match on the product's sentences, including "about"                     × 0.2
 *   meaning   closest sentence by vector similarity (all-MiniLM-L6-v2 + OpenSearch k-NN)        × 0.45
 * A product needs a keyword or about match, or a meaning match close to the best one. Filters
 * (city, price, stock, last units, kids' items) come from the live stock index. Null = not available
 * or nothing matched: the caller falls back to keywords with its loosening steps.
 */
async function hybridSearch(a: {
  p: SearchParams; city: string; text: string; semanticText: string; uses: Use[];
  must: object[]; mustNot: object[]; filter: object[]; cheapestFirst: boolean;
}) {
  const scores = await catalogScores(a.semanticText, a.text);
  if (!scores) return null;
  const alias = searchIndex().alias;

  // Keywords on the stock index (same query as the keyword path, all hits, with highlights).
  const lex = new Map<number, { score: number; hl?: Record<string, string[]> }>();
  if (a.must.length) {
    const res = await getSearch().search({
      index: alias,
      body: {
        size: 400, _source: ['product_id'],
        query: { bool: { must: a.must, must_not: a.mustNot, filter: a.filter } },
        ...(a.text ? { highlight: { pre_tags: ['[['], post_tags: [']]'], fields: { features: { number_of_fragments: 1, fragment_size: 90 }, specs_text: { number_of_fragments: 1, fragment_size: 70 }, description: { number_of_fragments: 1, fragment_size: 110 } } } } : {}),
      } as never,
    });
    for (const h of (res.body as any).hits.hits) lex.set(h._source.product_id, { score: h._score, hl: h.highlight });
  }

  const semTop = Math.max(0, ...scores.sem.values());
  // A relative-only floor admits arbitrary nearest neighbours for nonsense queries. Cosine
  // similarity must also be strong enough in absolute terms before it can create a candidate.
  const semFloor = Math.max(0.42, semTop - 0.10);
  const aboutTop = Math.max(0, ...[...scores.about.values()].map((v) => v.score));
  const lexTop = Math.max(0, ...[...lex.values()].map((v) => v.score));
  const candidates = new Set<number>([
    ...lex.keys(),
    ...[...scores.about].filter(([, v]) => v.score >= 0.35 * aboutTop).map(([id]) => id),
    ...[...scores.sem].filter(([, s]) => s >= semFloor).map(([id]) => id),
  ]);
  // A cheapest-first request names a product type as well as a price preference. Keep that
  // type constraint after candidate fusion; otherwise an unrelated cheap neighbour can win.
  if (a.cheapestFirst && a.text) for (const id of candidates) if (!lex.has(id)) candidates.delete(id);
  if (!candidates.size) return null;

  // The live stock docs for those products, with every filter applied.
  const docs = await getSearch().search({
    index: alias,
    body: { size: 500, query: { bool: { must_not: a.mustNot, filter: [...a.filter, { terms: { product_id: [...candidates] } }] } } } as never,
  });
  const matched = ((docs.body as any).hits.hits as { _source: Src }[]).map(({ _source: src }) => {
    const id = src.product_id;
    const L = lexTop ? (lex.get(id)?.score ?? 0) / lexTop : 0;
    const A = aboutTop ? (scores.about.get(id)?.score ?? 0) / aboutTop : 0;
    const s = scores.sem.get(id) ?? 0;
    const S = semTop > 0.15 ? Math.min(1, Math.max(0, (s - 0.15) / (semTop - 0.15))) : 0;
    const why = whyMatched(src, lex.get(id)?.hl, a.uses)
      ?? (scores.about.get(id)?.text || (s >= semFloor ? scores.semText.get(id) : '') || null);
    return { src, score: 0.5 * L + 0.2 * A + 0.45 * S, why: why ? why.replace(/^[^:]{1,60}:\s*/, '') : null };
  });
  if (!matched.length) return null;

  type M = (typeof matched)[number];
  const stock = (x: M, y: M) => Number(y.src.in_stock) - Number(x.src.in_stock);
  matched.sort((x, y) => {
    switch (a.p.sort) {
      case 'price_asc': return stock(x, y) || x.src.price_paise - y.src.price_paise;
      case 'price_desc': return stock(x, y) || y.src.price_paise - x.src.price_paise;
      case 'stock': return y.src.qty - x.src.qty || y.score - x.score;
      case 'name': return x.src.name.localeCompare(y.src.name);
      default: return stock(x, y)
        || (a.cheapestFirst ? x.src.price_paise - y.src.price_paise : y.score - x.score)
        || x.src.price_paise - y.src.price_paise;
    }
  });

  // Facets before the category / "good for" filters, so every option keeps its count.
  const count = (keys: string[]) => [...keys.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())]
    .sort((x, y) => y[1] - x[1]).map(([key, n]) => ({ key, count: n }));
  const facets = {
    categories: count(matched.map((m) => m.src.category)),
    uses: count(matched.flatMap((m) => m.src.uses ?? [])).map((u) => ({ ...u, label: USES[u.key as Use] ?? u.key })),
    priceBands: PRICE_BANDS.map((b) => ({ key: b.key, count: matched.filter((m) => m.src.price_paise >= (b.from ?? 0) && m.src.price_paise < (b.to ?? Infinity)).length })),
    colours: count(matched.flatMap((m) => (m.src.colour ? [m.src.colour] : []))),
    connectivity: count(matched.flatMap((m) => (m.src.connectivity ?? []).filter((c) => c !== 'none'))),
    water: count(matched.flatMap((m) => (m.src.water_rating && m.src.water_rating !== 'none' ? [m.src.water_rating] : []))),
    battery: [8, 20, 30, 168].map((h) => ({ key: String(h), count: matched.filter((m) => (m.src.battery_hours ?? 0) >= h).length })).filter((b) => b.count > 0),
  };
  const shown = matched.filter((m) => (!a.p.category || m.src.category === a.p.category) && (!a.p.use || (m.src.uses ?? []).includes(a.p.use))
    && (!a.p.conn || (m.src.connectivity ?? []).includes(a.p.conn)) && (!a.p.water || m.src.water_rating === a.p.water));
  const from = (a.p.page - 1) * a.p.size;
  return { total: shown.length, page: shown.slice(from, from + a.p.size), facets };
}

/** One line: the occasions that matched, then the best matching feature or description snippet. */
function whyMatched(s: Src, hl: Record<string, string[]> | undefined, uses: Use[]): string | null {
  const parts: string[] = [];
  const hit = (s.uses ?? []).filter((u) => uses.includes(u as Use)).map((u) => USES[u as Use]);
  if (hit.length) parts.push(`Good for ${hit.join(', ').toLowerCase()}`);
  const snippet = hl?.features?.[0] ?? hl?.specs_text?.[0] ?? hl?.description?.[0];
  if (snippet) parts.push(snippet.trim());
  return parts.length ? parts.join(' · ') : null;
}

/**
 * "Similar, in stock near you" (doc/19): OpenSearch more_like_this on this product's own document,
 * limited to the shopper's city and to things actually on the shelf. Used when the item is gone,
 * so the shopper sees real alternatives instead of a dead end.
 */
export async function similarProducts(productId: number, city: string, size = 6): Promise<SearchItem[]> {
  const res = await os(() =>
    getSearch().search({
      index: searchIndex().alias,
      body: {
        size,
        query: {
          bool: {
            must: [{
              more_like_this: {
                fields: ['name', 'description', 'features', 'tags', 'about', 'specs_text'],
                like: [{ _index: searchIndex().alias, _id: docId(productId, city) }],
                min_term_freq: 1,
                min_doc_freq: 1,
                max_query_terms: 25,
                minimum_should_match: '20%',
              },
            }],
            filter: [{ term: { city } }, { term: { in_stock: true } }],
            must_not: [{ term: { product_id: productId } }],
          },
        },
      } as never,
    }),
  );
  const hits = (res.body as unknown as { hits: { hits: { _source: Src }[] } }).hits.hits;
  return hits.map((h) => toItem(h._source, new Map()));
}

/** Products by id in one city (one mget), in the order given; ids not in the index are skipped. */
export async function productsInCity(productIds: number[], city: string): Promise<SearchItem[]> {
  if (!productIds.length) return [];
  const res = await os(() => getSearch().mget({ index: searchIndex().alias, body: { ids: productIds.map((id) => docId(id, city)) } }));
  const docs = (res.body as unknown as { docs: { found: boolean; _source?: Src }[] }).docs;
  return docs.filter((d) => d.found && d._source).map((d) => toItem(d._source!, new Map()));
}

/**
 * What goes WITH these products (complements, not look-alikes): in stock in this city, sharing an
 * occasion ("good for commute") with them but from another category. Headphones → power bank, bag.
 */
export async function goesWith(productIds: number[], city: string, size = 6): Promise<SearchItem[]> {
  const res = await os(() => getSearch().mget({ index: searchIndex().alias, body: { ids: productIds.map((id) => docId(id, city)) } }));
  const src = (res.body as unknown as { docs: { found: boolean; _source?: Src }[] }).docs.filter((d) => d.found).map((d) => d._source!);
  const uses = [...new Set(src.flatMap((s) => s.uses ?? []))];
  const categories = [...new Set(src.map((s) => s.category))];
  if (!uses.length) return productIds[0] ? similarProducts(productIds[0], city, size) : [];
  const hits = await os(() =>
    getSearch().search({
      index: searchIndex().alias,
      body: {
        size,
        query: {
          bool: {
            filter: [{ term: { city } }, { term: { in_stock: true } }, { terms: { uses } }],
            must_not: [{ terms: { product_id: productIds } }, { terms: { category: categories } }],
            // More shared occasions first; between equals, what the shelf has plenty of.
            should: uses.map((u) => ({ term: { uses: u } })),
          },
        },
        sort: ['_score', { qty: 'desc' }],
      } as never,
    }),
  );
  return (hits.body as unknown as { hits: { hits: { _source: Src }[] } }).hits.hits.map((h) => toItem(h._source, new Map()));
}

/** Live stock for cards on screen: one mget (doc/03 §4.5). */
/**
 * Live stock for the polling cards. Valkey first (one pipelined round trip, every city per product,
 * so "nearest city with stock" needs no second query). On a miss: ONE OpenSearch mget for every
 * city of these products, then refill Valkey (version-guarded). See server/lib/cache.ts.
 */
export async function liveStock(city: string, productIds: number[]): Promise<{ source: 'valkey' | 'opensearch'; items: LiveItem[] }> {
  const cached = await readStock(productIds);
  if (cached) return { source: 'valkey', items: toLiveItems(city, productIds, cached) };

  const ids = productIds.flatMap((id) => CityCode.options.map((c) => docId(id, c)));
  const res = await os(() => getSearch().mget({ index: searchIndex().alias, body: { ids } }));
  const docs = (res.body as unknown as { docs: { found: boolean; _source?: Src }[] }).docs;
  const entries: StockEntry[] = docs
    .filter((d) => d.found && d._source)
    .map(({ _source: s }) => ({ productId: s!.product_id, city: s!.city, cityName: s!.city_name, qty: s!.qty, version: s!.stock_version }));
  void cacheStock(entries);
  const byProduct = new Map<number, StockEntry[]>();
  for (const e of entries) byProduct.set(e.productId, [...(byProduct.get(e.productId) ?? []), e]);
  return { source: 'opensearch', items: toLiveItems(city, productIds, byProduct) };
}

/**
 * The pre-Valkey path, kept unchanged for A/B benchmarks (`/api/stock?cache=off`, doc/15): an
 * OpenSearch mget for this city's docs, plus a second OpenSearch search for "nearest city with
 * stock" whenever something is sold out. Never touches Valkey.
 */
export async function liveStockLegacy(city: string, productIds: number[]): Promise<{ source: 'opensearch'; items: LiveItem[] }> {
  const res = await os(() =>
    getSearch().mget({ index: searchIndex().alias, body: { ids: productIds.map((id) => docId(id, city)) } }),
  );
  const docs = (res.body as unknown as { docs: { found: boolean; _source?: Src }[] }).docs;
  const sources = docs.filter((d) => d.found && d._source).map((d) => d._source!);
  const nearby = await nearbyFor(sources.filter((s) => !s.in_stock).map((s) => s.product_id), city);
  return {
    source: 'opensearch',
    items: sources.map((s) => {
      const i = toItem(s, nearby);
      return { productId: i.productId, city: i.city, qty: i.qty, inStock: i.inStock, stockVersion: i.stockVersion, nearby: i.nearby };
    }),
  };
}

export interface LiveItem { productId: number; city: string; qty: number; inStock: boolean; stockVersion: number; nearby: Nearby | null }

function toLiveItems(city: string, productIds: number[], byProduct: Map<number, StockEntry[]>): LiveItem[] {
  const out: LiveItem[] = [];
  for (const id of productIds) {
    const all = byProduct.get(id) ?? [];
    const own = all.find((e) => e.city === city);
    if (!own) continue;
    const inStock = own.qty > 0;
    let nearby: Nearby | null = null;
    if (!inStock) {
      for (const e of all) {
        if (e.city !== city && e.qty > 0 && (!nearby || e.qty > nearby.qty)) nearby = { city: e.city, cityName: e.cityName, qty: e.qty };
      }
    }
    out.push({ productId: id, city, qty: own.qty, inStock, stockVersion: own.version, nearby });
  }
  return out;
}

export async function nearbyFor(productIds: number[], excludeCity: string): Promise<Map<number, Nearby>> {
  const out = new Map<number, Nearby>();
  if (productIds.length === 0) return out;
  const res = await os(() =>
    getSearch().search({
      index: searchIndex().alias,
      body: {
        size: 100,
        query: {
          bool: {
            filter: [{ terms: { product_id: productIds } }, { term: { in_stock: true } }],
            must_not: [{ term: { city: excludeCity } }],
          },
        },
      } as never,
    }),
  );
  const hits = (res.body as unknown as { hits: { hits: { _source: Src }[] } }).hits.hits;
  for (const { _source: s } of hits) {
    const best = out.get(s.product_id);
    if (!best || s.qty > best.qty) out.set(s.product_id, { city: s.city, cityName: s.city_name, qty: s.qty });
  }
  return out;
}
