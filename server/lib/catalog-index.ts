import { createHash } from 'node:crypto';
import { getPool } from './db.js';
import { getSearch } from './search.js';
import { productsIndexBody } from './search-schema.js';
import { EMBED_DIM, EMBED_MODEL, embedDocs, embedQuery } from './embed.js';
import { log } from './log.js';

/**
 * Meaning search index (doc/19): one OpenSearch document per product SENTENCE (name + description,
 * feature bullets, each sentence of "about"), each with a k-NN vector from embed.ts. A query is
 * matched against every sentence and a product scores by its best one, so "my phone keeps dying"
 * finds the power bank whose about says "for phones that run out of battery".
 *
 * Separate from the per-city stock index (products alias), which the Kafka indexer keeps live:
 * product text changes rarely, stock changes constantly. Search joins the two (search-query.ts).
 * Kept in sync from PostgreSQL by syncCatalog(): on web start-up, and `npm run search:catalog`.
 * Only products whose text changed are re-embedded (a hash per product).
 */

export const VECTOR_INDEX = process.env.OPENSEARCH_VECTOR_INDEX ?? 'product_vectors';

const vectorIndexBody = {
  settings: {
    index: { knn: true, number_of_shards: 1, number_of_replicas: 0 },
    analysis: productsIndexBody.settings.analysis,
  },
  mappings: {
    dynamic: 'strict',
    properties: {
      product_id: { type: 'integer' },
      chunk: { type: 'integer' },
      text: { type: 'text', analyzer: 'product_text' },
      hash: { type: 'keyword' },
      model: { type: 'keyword' },
      embedding: {
        type: 'knn_vector',
        dimension: EMBED_DIM,
        method: { name: 'hnsw', engine: 'lucene', space_type: 'cosinesimil' },
      },
    },
  },
};

interface Row { id: number; name: string; description: string; features: string[]; about: string; tags: string[]; brand: string }

/** The sentences a product is matched by. */
export function chunksFor(p: Row): string[] {
  const out = [`${p.name} by ${p.brand}: ${p.description}`];
  if (p.features.length) out.push(`${p.name}: ${p.features.join('; ')}.`);
  for (const s of p.about.split(/(?<=[.!?])\s+/)) if (s.trim()) out.push(`${p.name}: ${s.trim()}`);
  if (p.tags.length) out.push(`${p.name}: ${p.tags.join(', ')}`);
  return out;
}

const hashOf = (p: Row) => createHash('sha256').update(`${EMBED_MODEL}\n${chunksFor(p).join('\n')}`).digest('hex').slice(0, 16);

let ready = false;
/** True once the vector index exists and has documents (search uses it only then). */
export const catalogReady = () => ready;

/** Create the index if needed and (re-)embed products whose text changed. Safe to run concurrently. */
export async function syncCatalog(): Promise<{ embedded: number; total: number } | null> {
  const os = getSearch();
  try {
    const exists = (await os.indices.exists({ index: VECTOR_INDEX })).body;
    if (!exists) await os.indices.create({ index: VECTOR_INDEX, body: vectorIndexBody as never });

    const { rows } = await getPool().query<Row>('SELECT id, name, brand, description, features, about, tags FROM products ORDER BY id');
    const res = await os.search({
      index: VECTOR_INDEX,
      body: { size: 0, aggs: { p: { terms: { field: 'product_id', size: 5000 }, aggs: { h: { terms: { field: 'hash', size: 2 } } } } } } as never,
    });
    const have = new Map<number, string>();
    for (const b of (res.body as any).aggregations.p.buckets) if (b.h.buckets.length === 1) have.set(b.key, b.h.buckets[0].key);

    const stale = rows.filter((r) => have.get(r.id) !== hashOf(r));
    if (stale.length) {
      const chunks = stale.flatMap((r) => chunksFor(r).map((text, chunk) => ({ r, chunk, text })));
      const vectors = await embedDocs(chunks.map((c) => c.text));
      if (!vectors) { ready = have.size > 0; return null; }
      await os.deleteByQuery({ index: VECTOR_INDEX, body: { query: { terms: { product_id: stale.map((r) => r.id) } } }, refresh: true, conflicts: 'proceed' });
      for (let i = 0; i < chunks.length; i += 200) {
        const body = chunks.slice(i, i + 200).flatMap((c, j) => [
          { index: { _index: VECTOR_INDEX, _id: `${c.r.id}:${c.chunk}` } },
          { product_id: c.r.id, chunk: c.chunk, text: c.text, hash: hashOf(c.r), model: EMBED_MODEL, embedding: vectors[i + j] },
        ]);
        const bulk = await os.bulk({ body });
        if ((bulk.body as { errors: boolean }).errors) throw new Error('bulk indexing product vectors failed');
      }
      await os.indices.refresh({ index: VECTOR_INDEX });
    }
    ready = true;
    log.info('catalog: meaning index in sync', { index: VECTOR_INDEX, products: rows.length, embedded: stale.length });
    return { embedded: stale.length, total: rows.length };
  } catch (e) {
    log.warn('catalog: meaning index sync failed, search uses keywords only', { err: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/**
 * Per product: best meaning match (cosine, -1..1) and best full-text match on its sentences
 * (including "about", which the stock index doesn't carry). One msearch round trip.
 */
export async function catalogScores(semanticText: string, lexicalText: string): Promise<{
  sem: Map<number, number>; semText: Map<number, string>; about: Map<number, { score: number; text: string }>;
} | null> {
  if (!ready) return null;
  const vector = semanticText ? await embedQuery(semanticText) : null;
  const searches: object[] = [];
  if (vector) searches.push({ index: VECTOR_INDEX }, { size: 400, _source: ['product_id', 'text'], query: { knn: { embedding: { vector, k: 400 } } } });
  if (lexicalText) {
    searches.push({ index: VECTOR_INDEX }, {
      size: 400, _source: ['product_id', 'text'],
      query: { bool: { should: [
        { match: { text: { query: lexicalText, analyzer: 'product_text_syn', boost: 2 } } },
        { match: { text: { query: lexicalText, fuzziness: 'AUTO', prefix_length: 1 } } },
      ] } },
    });
  }
  if (!searches.length) return { sem: new Map(), semText: new Map(), about: new Map() };
  const res = await getSearch().msearch({ body: searches as never });
  const responses = (res.body as { responses: { hits?: { hits: { _score: number; _source: { product_id: number; text?: string } }[] } }[] }).responses;
  const sem = new Map<number, number>();
  const semText = new Map<number, string>();
  const about = new Map<number, { score: number; text: string }>();
  let k = 0;
  if (vector) {
    // lucene cosinesimil scores are (1 + cos) / 2: turn back into cosine.
    for (const h of responses[k++]?.hits?.hits ?? []) {
      const cos = 2 * h._score - 1;
      if (cos > (sem.get(h._source.product_id) ?? -2)) { sem.set(h._source.product_id, cos); semText.set(h._source.product_id, h._source.text ?? ''); }
    }
  }
  if (lexicalText) {
    for (const h of responses[k++]?.hits?.hits ?? []) {
      const best = about.get(h._source.product_id);
      if (!best || h._score > best.score) about.set(h._source.product_id, { score: h._score, text: h._source.text ?? '' });
    }
  }
  return { sem, semText, about };
}
