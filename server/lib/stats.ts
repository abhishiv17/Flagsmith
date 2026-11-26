import { getPool } from './db.js';

/** Upsert a pipeline_stats row (heartbeats, consumer lag). Read by /api/ops/summary. */
export async function putStat(key: string, value: unknown): Promise<void> {
  await getPool().query(
    `INSERT INTO pipeline_stats (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
