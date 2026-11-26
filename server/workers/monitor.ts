import { getKafka, topics } from '../lib/kafka.js';
import { putStat, sleep } from '../lib/stats.js';
import { log, errMsg } from '../lib/log.js';
import { INDEXER_GROUP } from './indexer.js';
import { NOTIFIER_GROUP } from './notifier.js';
import { ANALYTICS_GROUP } from './analytics.js';
import { CLICKHOUSE_GROUP } from './clickhouse.js';

/**
 * Pipeline monitor (doc/03 §4.6). The Vercel API can't talk to Kafka, so this loop computes
 * consumer lag and stores it in pipeline_stats for /api/ops/summary. It runs independently of
 * the consumers, so a killed indexer's lag keeps being reported (and climbs on screen).
 */
export async function runMonitor(signal: AbortSignal): Promise<void> {
  const t = topics();
  const watch: { group: string; topic: string }[] = [
    { group: INDEXER_GROUP, topic: t.inventory },
    { group: NOTIFIER_GROUP, topic: t.orders },
    { group: NOTIFIER_GROUP, topic: t.inventory },
    { group: ANALYTICS_GROUP, topic: t.activity },
    { group: CLICKHOUSE_GROUP, topic: t.orders },
    { group: CLICKHOUSE_GROUP, topic: t.activity },
  ];
  const admin = getKafka().admin();
  await admin.connect();
  log.info('monitor: started');

  try {
    while (!signal.aborted) {
      try {
        for (const { group, topic } of watch) {
          const ends = await admin.fetchTopicOffsets(topic);
          const committed = await admin.fetchOffsets({ groupId: group, topics: [topic] });
          const parts = committed[0]?.partitions ?? [];
          let lag = 0;
          for (const end of ends) {
            const c = Number(parts.find((p) => p.partition === end.partition)?.offset ?? -1);
            const from = c >= 0 ? c : Number(end.low);
            lag += Math.max(0, Number(end.high) - from);
          }
          await putStat(`lag:${group}:${topic}`, { group, topic, lag });
        }
      } catch (e) {
        log.warn('monitor: lag check failed', { err: errMsg(e) });
      }
      await sleep(2000);
    }
  } finally {
    await admin.disconnect().catch(() => {});
    log.info('monitor: stopped');
  }
}
