/**
 * Creates the products index + alias if missing.
 * Usage: npm run search:init               (idempotent)
 *        npm run search:init -- --recreate  (drops and recreates: used by demo:reset)
 */
import { getSearch, searchIndex } from '../server/lib/search.js';
import { productsIndexBody } from '../server/lib/search-schema.js';

async function main() {
  const os = getSearch();
  const { alias, indexName } = searchIndex();
  const recreate = process.argv.includes('--recreate');

  const exists = (await os.indices.exists({ index: indexName })).body;
  if (exists && recreate) {
    await os.indices.delete({ index: indexName });
    console.log(`- deleted ${indexName}`);
  }
  if (!exists || recreate) {
    await os.indices.create({ index: indexName, body: productsIndexBody as never });
    console.log(`+ created ${indexName} (1 shard, 0 replicas)`);
  } else {
    console.log(`= ${indexName} already exists`);
  }

  await os.indices.updateAliases({
    body: { actions: [{ add: { index: indexName, alias } }] },
  });
  console.log(`= alias ${alias} → ${indexName}`);
}

main().catch((e) => {
  console.error('search:init failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
