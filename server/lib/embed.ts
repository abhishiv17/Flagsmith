import path from 'node:path';
import { log } from './log.js';

/**
 * Meaning search (doc/19): a small open sentence-embedding model that runs inside the web process
 * (all-MiniLM-L6-v2, ONNX, CPU, ~23 MB, a few ms per query). Products and queries become 384-number vectors; OpenSearch
 * k-NN finds the products closest in meaning ("my phone keeps dying" ≈ "power bank").
 *
 * The model files are baked into the Docker image at build time (scripts/fetch-model.ts), so nothing
 * is downloaded while serving. If the model can't load, embed() returns null and search falls back to
 * keyword matching: search never breaks because of this.
 */

export const EMBED_MODEL = process.env.EMBED_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
export const EMBED_DIM = 384;
/** bge models want this in front of a search query (not in front of documents). */
const QUERY_PREFIX = EMBED_MODEL.includes('bge') ? 'Represent this sentence for searching relevant passages: ' : '';
export const MODEL_DIR = process.env.MODEL_DIR ?? path.join(process.cwd(), '.models');

type Extractor = (texts: string[], opts: { pooling: 'cls' | 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
let loading: Promise<Extractor | null> | undefined;

export function loadEmbedder(): Promise<Extractor | null> {
  loading ??= (async () => {
    try {
      const t = await import('@huggingface/transformers');
      t.env.cacheDir = MODEL_DIR;
      t.env.allowLocalModels = true;
      const started = Date.now();
      const extractor = (await t.pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' })) as unknown as Extractor;
      log.info('embed: model ready', { model: EMBED_MODEL, ms: Date.now() - started });
      return extractor;
    } catch (e) {
      log.warn('embed: model unavailable, search uses keywords only', { model: EMBED_MODEL, err: e instanceof Error ? e.message : String(e) });
      return null;
    }
  })();
  return loading;
}

const pooling = () => (EMBED_MODEL.includes('bge') ? 'cls' : 'mean') as 'cls' | 'mean';

/** Vectors for product texts (no query prefix). Null if the model isn't available. */
export async function embedDocs(texts: string[]): Promise<number[][] | null> {
  const ex = await loadEmbedder();
  if (!ex) return null;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 16) out.push(...(await ex(texts.slice(i, i + 16), { pooling: pooling(), normalize: true })).tolist());
  return out;
}

const cache = new Map<string, number[]>();
/** Vector for a shopper's query, cached (search-as-you-type repeats itself). Null if unavailable. */
export async function embedQuery(text: string): Promise<number[] | null> {
  const key = text.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  const ex = await loadEmbedder();
  if (!ex) return null;
  const v = (await ex([QUERY_PREFIX + key], { pooling: pooling(), normalize: true })).tolist()[0]!;
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  cache.set(key, v);
  return v;
}
