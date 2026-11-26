/**
 * Zero-downtime reindex (doc/19): build a NEW index from PostgreSQL, then swap the alias in one
 * atomic step. Shoppers keep searching the old index until the swap.
 *
 * Usage: npm run search:reindex            (target = OPENSEARCH_INDEX_NAME, e.g. products_v2)
 *
 * 1. Create the target index with the current schema (search-schema.ts) if it doesn't exist.
 * 2. Pass 1: bulk-write every product × city from PostgreSQL with EXTERNAL versioning = the
 *    inventory version, exactly what the indexer would write. A newer version always wins.
 * 3. Swap the alias (remove old, add new) in one request: the indexer's next write goes to the new index.
 * 4. Pass 2: write again from PostgreSQL. Anything that changed between pass 1 and the swap was
 *    indexed into the OLD index by the indexer; this pass brings it over. Stale versions are refused
 *    by OpenSearch (409), so running it twice is harmless.
 * 5. Check: document counts match PostgreSQL.
 */
import 'dotenv/config';
import { closePool, getPool } from '../server/lib/db.js';
import { getSearch, searchIndex } from '../server/lib/search.js';
import { productsIndexBody } from '../server/lib/search-schema.js';
import { docId, toSearchDoc, type InventoryChanged } from '../server/lib/events.js';

const os = getSearch();
const { alias, indexName: target } = searchIndex();
const pool = getPool();

async function fromPostgres() {
  const { rows } = await pool.query<{
    product_id: number; city_code: string; qty: number; version: string; sku: string; name: string; brand: string;
    category: string; description: string; tags: string[]; price_paise: number; image_key: string; city_name: string;
    features: string[]; uses: string[]; about: string; specs: { group: string; label: string; value: string }[]; in_box: string[];
    colour: string | null; connectivity: string[]; water_rating: string | null; battery_hours: number | null; weight_g: number | null;
  }>(
    `SELECT i.product_id, i.city_code, i.qty, i.version, p.sku, p.name, p.brand, p.category, p.description, p.tags,
            p.price_paise, p.image_key, c.name AS city_name, p.features, p.uses, p.about, p.specs, p.in_box,
            p.colour, p.connectivity, p.water_rating, p.battery_hours, p.weight_g
       FROM inventory i JOIN products p ON p.id = i.product_id JOIN cities c ON c.code = i.city_code`,
  );
  return rows.map((r): InventoryChanged => ({
    productId: r.product_id, cityCode: r.city_code, qty: r.qty, delta: 0, version: Number(r.version), reason: 'seed', orderId: null,
    doc: {
      sku: r.sku, name: r.name, brand: r.brand, category: r.category, description: r.description, tags: r.tags,
      pricePaise: r.price_paise, imageKey: r.image_key, cityName: r.city_name, features: r.features, uses: r.uses,
      about: r.about, specs: r.specs, inBox: r.in_box, colour: r.colour, connectivity: r.connectivity,
      waterRating: r.water_rating, batteryHours: r.battery_hours, weightG: r.weight_g,
    },
  }));
}

async function write(index: string, events: InventoryChanged[]) {
  let ok = 0, stale = 0, failed = 0;
  for (let i = 0; i < events.length; i += 200) {
    const body = events.slice(i, i + 200).flatMap((e) => [
      { index: { _index: index, _id: docId(e.productId, e.cityCode), version: e.version, version_type: 'external' } },
      toSearchDoc(e),
    ]);
    const res = await os.bulk({ body, refresh: false });
    for (const it of (res.body as { items: { index: { status: number } }[] }).items) {
      if (it.index.status < 300) ok++;
      else if (it.index.status === 409) stale++; // already has this version or newer: fine
      else failed++;
    }
  }
  return { ok, stale, failed };
}

try {
  const current = Object.keys((await os.indices.getAlias({ name: alias }).catch(() => ({ body: {} }))).body as object);
  console.log(`alias ${alias} → ${current.join(', ') || '(none)'}; target ${target}`);
  if (current.includes(target)) console.log('target already live: running a catch-up pass only');

  if (!(await os.indices.exists({ index: target })).body) {
    await os.indices.create({ index: target, body: productsIndexBody as never });
    console.log(`+ created ${target}`);
  }

  const t0 = Date.now();
  const p1 = await write(target, await fromPostgres());
  console.log('pass 1', p1);

  if (!current.includes(target)) {
    await os.indices.updateAliases({
      body: { actions: [...current.map((index) => ({ remove: { index, alias } })), { add: { index: target, alias } }] },
    });
    console.log(`= alias ${alias} → ${target} (atomic swap)`);
  }

  const p2 = await write(target, await fromPostgres());
  console.log('pass 2 (catch-up)', p2);
  await os.indices.refresh({ index: target });

  const pgCount = Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM inventory')).rows[0]!.n);
  const osCount = (await os.count({ index: target })).body as { count: number };
  console.log(JSON.stringify({ target, docs: osCount.count, postgresRows: pgCount, inSync: osCount.count === pgCount, ms: Date.now() - t0 }));
  if (p1.failed || p2.failed) process.exitCode = 1;
} finally {
  await closePool();
}
