import pg from 'pg';
import { attachDatabasePool } from '@vercel/functions';
import { pgConfig } from '../config.js';
import { log, errMsg } from './log.js';

let pool: pg.Pool | undefined;

/**
 * True when PostgreSQL itself refused a new connection because every slot is taken (Aiven free tier:
 * 15 connections, 12 usable, shared by Vercel instances, workers and laptops). Safe to retry: the
 * request never reached the database.
 */
export function isSlotsFull(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | undefined;
  return err?.code === '53300' || /remaining connection slots|too many clients/i.test(err?.message ?? '');
}

/** Slots full, or this process waited PG_CONNECT_TIMEOUT_MS for a pooled connection: report 503 BUSY. */
export function isDbBusy(e: unknown): boolean {
  return isSlotsFull(e) || /timeout exceeded when trying to connect/i.test((e as { message?: string })?.message ?? '');
}

/**
 * Retry new connections that PostgreSQL rejects with "slots full" (~150/300/600 ms + jitter), so a
 * short burst queues briefly instead of failing. Patches `connect` itself, which `pool.query` also
 * uses, so every query and transaction gets the same behaviour.
 */
function retryWhenFull(p: pg.Pool): void {
  const original = p.connect.bind(p) as () => Promise<pg.PoolClient>;
  const connectWithRetry = async (): Promise<pg.PoolClient> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await original();
      } catch (e) {
        if (attempt >= 3 || !isSlotsFull(e)) throw e;
        await new Promise((r) => setTimeout(r, 150 * 2 ** attempt + Math.random() * 100));
      }
    }
  };
  type Cb = (err: Error | undefined, client?: pg.PoolClient, done?: (release?: unknown) => void) => void;
  (p as unknown as { connect: (cb?: Cb) => Promise<pg.PoolClient> | void }).connect = (cb?: Cb) => {
    if (!cb) return connectWithRetry();
    connectWithRetry().then(
      (client) => cb(undefined, client, (release?: unknown) => client.release(release as boolean | Error | undefined)),
      (e: Error) => cb(e),
    );
  };
}

/**
 * One pool per process. On Vercel (Fluid compute) set PG_POOL_MAX=1: each instance then holds at most
 * one connection, and attachDatabasePool keeps the instance alive just long enough to close idle
 * connections before it is suspended, so frozen instances stop hoarding slots. No-op off Vercel.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool(pgConfig());
    pool.on('error', (e) => log.error('pg pool error', { err: errMsg(e) }));
    retryWhenFull(pool);
    attachDatabasePool(pool);
  }
  return pool;
}

export type Tx = pg.PoolClient;

/** Run `fn` in a READ COMMITTED transaction; rolls back on any throw. */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
