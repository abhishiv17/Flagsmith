/**
 * Build / refresh the meaning-search index (doc/19, server/lib/catalog-index.ts) from PostgreSQL.
 * Only products whose text changed are re-embedded. The web app also does this on start-up, so this
 * is for after `npm run products:more` or editing product text, to see it straight away.
 * Usage: npm run search:catalog
 */
import 'dotenv/config';
import { closePool } from '../server/lib/db.js';
import { syncCatalog, VECTOR_INDEX } from '../server/lib/catalog-index.js';

const started = Date.now();
const r = await syncCatalog();
console.log(r
  ? `${VECTOR_INDEX}: ${r.total} products, ${r.embedded} (re-)embedded in ${((Date.now() - started) / 1000).toFixed(1)} s.`
  : 'Meaning index not updated (model or OpenSearch unavailable): see the log above. Search still works with keywords.');
await closePool();
process.exit(r ? 0 : 1);
