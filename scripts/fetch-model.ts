/**
 * Download the meaning-search model (doc/19) into .models/ so the server never downloads at runtime.
 * Run at Docker build time; locally it happens on first use anyway.
 * Usage: npm run model:fetch
 */
import { EMBED_MODEL, MODEL_DIR, embedQuery } from '../server/lib/embed.js';

const v = await embedQuery('warm-up');
if (!v) {
  console.error(`Could not load ${EMBED_MODEL}`);
  process.exit(1);
}
console.log(`${EMBED_MODEL} ready in ${MODEL_DIR} (${v.length} dimensions)`);
