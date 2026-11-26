/**
 * Creates the Kafka topics we need (idempotent). Usage: npm run kafka:topics
 * Topic design: doc/04 §2. Partition count 2 = keyed ordering per product:city with room for 2 consumers.
 */
import { getKafka, topics } from '../server/lib/kafka.js';

async function main() {
  const t = topics();
  const wanted = [
    { topic: t.orders, numPartitions: 2 },
    { topic: t.inventory, numPartitions: 2 },
    { topic: t.smoke, numPartitions: 1 },
    { topic: t.activity, numPartitions: 2 },
  ];
  const admin = getKafka().admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const missing = wanted.filter((w) => !existing.has(w.topic));
    if (missing.length) {
      await admin.createTopics({ topics: missing, waitForLeaders: true });
    }
    for (const w of wanted) {
      console.log(`${existing.has(w.topic) ? '=' : '+'} ${w.topic} (${w.numPartitions} partition${w.numPartitions > 1 ? 's' : ''})`);
    }
  } finally {
    await admin.disconnect();
  }
}

main().catch((e) => {
  console.error('kafka:topics failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
