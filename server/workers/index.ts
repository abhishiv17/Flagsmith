/**
 * Long-running worker host: relay, indexer, notifier, monitor (doc/03 §2). Not for Vercel.
 *
 *   npm run workers                       all four
 *   npm run workers -- --only=indexer     just the indexer (Drill 2: kill this one on stage)
 *   npm run workers -- --only=relay,notifier,monitor
 */
import { log, errMsg } from '../lib/log.js';
import { putStat } from '../lib/stats.js';
import { closePool } from '../lib/db.js';
import { runRelay } from './relay.js';
import { runIndexer } from './indexer.js';
import { runNotifier } from './notifier.js';
import { runMonitor } from './monitor.js';
import { runAnalytics } from './analytics.js';
import { runClickhouse } from './clickhouse.js';

const ALL = { relay: runRelay, indexer: runIndexer, notifier: runNotifier, monitor: runMonitor, analytics: runAnalytics, clickhouse: runClickhouse } as const;
type Name = keyof typeof ALL;

const onlyArg = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const names = (onlyArg ? onlyArg.split(',') : Object.keys(ALL)) as Name[];
for (const n of names) {
  if (!(n in ALL)) {
    console.error(`Unknown worker "${n}". Choose from: ${Object.keys(ALL).join(', ')}`);
    process.exit(1);
  }
}

const controller = new AbortController();

// Heartbeats let /ops show which workers are alive (stale after 6 s).
const beat = setInterval(() => {
  for (const n of names) {
    putStat(`heartbeat:${n}`, { name: n, pid: process.pid }).catch((e) =>
      log.warn('heartbeat failed', { err: errMsg(e) }),
    );
  }
}, 2000);

async function shutdown(sig: string) {
  if (controller.signal.aborted) return;
  log.info(`workers: ${sig} received, shutting down`);
  clearInterval(beat);
  controller.abort();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

log.info('workers: starting', { workers: names });
const runs = names.map((n) =>
  ALL[n](controller.signal).catch((e) => {
    log.error(`${n}: crashed`, { err: errMsg(e) });
    process.exitCode = 1;
    void shutdown('crash');
  }),
);
await Promise.allSettled(runs);
await closePool();
