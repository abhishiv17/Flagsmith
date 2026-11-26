import { getPool } from './db.js';
import { getSearch, searchIndex } from './search.js';
import { docId } from './events.js';

/** PG inventory vs OpenSearch docs: the "90/90 in sync" check on /ops and in check:sync. */
export async function indexDrift() {
  const { rows } = await getPool().query<{ product_id: number; city_code: string; qty: number; version: string }>(
    'SELECT product_id, city_code, qty, version FROM inventory ORDER BY product_id, city_code',
  );
  if (rows.length === 0) return { docs: 0, inSync: 0, drift: [] as { key: string; pgQty: number; pgVersion: number; osQty: number | null; osVersion: number | null }[] };

  const res = await getSearch().mget({
    index: searchIndex().alias,
    body: { ids: rows.map((r) => docId(r.product_id, r.city_code)) },
  });
  const docs = (res.body as unknown as { docs: { _id: string; found: boolean; _source?: { qty: number; stock_version: number } }[] }).docs;
  const byId = new Map(docs.map((d) => [d._id, d]));

  const drift = rows
    .map((r) => {
      const key = docId(r.product_id, r.city_code);
      const d = byId.get(key);
      return {
        key,
        pgQty: r.qty,
        pgVersion: Number(r.version),
        osQty: d?.found ? (d._source?.qty ?? null) : null,
        osVersion: d?.found ? (d._source?.stock_version ?? null) : null,
      };
    })
    .filter((x) => x.osVersion !== x.pgVersion || x.osQty !== x.pgQty);

  return { docs: rows.length, inSync: rows.length - drift.length, drift };
}
