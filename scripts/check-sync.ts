/**
 * Compares PostgreSQL inventory versions with the OpenSearch index (the /ops "drift" check).
 * Usage: npm run check:sync [-- --wait=60]   waits up to N seconds for 0 drift.
 */
import { getPool, closePool } from '../server/lib/db.js';
import { getSearch, searchIndex } from '../server/lib/search.js';
import { docId } from '../server/lib/events.js';

type Inv = { product_id: number; city_code: string; qty: number; version: string };

async function drift() {
  const { rows } = await getPool().query<Inv>('SELECT product_id, city_code, qty, version FROM inventory');
  const ids = rows.map((r) => docId(r.product_id, r.city_code));
  const res = await getSearch().mget({ index: searchIndex().alias, body: { ids } });
  const docs = (res.body as { docs: { _id: string; found: boolean; _source?: { stock_version: number; qty: number } }[] }).docs;
  const byId = new Map(docs.map((d) => [d._id, d]));
  const bad = rows.filter((r) => {
    const d = byId.get(docId(r.product_id, r.city_code));
    return !d?.found || d._source?.stock_version !== Number(r.version) || d._source?.qty !== r.qty;
  });
  return { total: rows.length, inSync: rows.length - bad.length, bad };
}

async function main() {
  const waitArg = process.argv.find((a) => a.startsWith('--wait='));
  const deadline = Date.now() + (waitArg ? Number(waitArg.slice(7)) * 1000 : 0);
  let r = await drift();
  while (r.bad.length && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 2000));
    r = await drift();
  }
  console.log(`${r.bad.length ? '❌' : '✅'} index sync: ${r.inSync}/${r.total} docs match PostgreSQL`);
  for (const b of r.bad.slice(0, 5)) console.log(`   drift: ${docId(b.product_id, b.city_code)} pg qty=${b.qty} v=${b.version}`);
  if (r.bad.length) process.exitCode = 1;
}

main().finally(closePool);
