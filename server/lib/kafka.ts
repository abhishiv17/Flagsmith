import { Kafka, logLevel, type Producer, type SASLOptions } from 'kafkajs';
import { kafkaConfig } from '../config.js';

/**
 * Kafka is used ONLY by long-running workers (relay, indexer, notifier) and scripts.
 * The Vercel API never touches Kafka: checkout writes to the PG outbox instead.
 */
process.env.KAFKAJS_NO_PARTITIONER_WARNING ??= '1';

let kafka: Kafka | undefined;

export function getKafka(): Kafka {
  if (!kafka) {
    const cfg = kafkaConfig();
    kafka = new Kafka({
      clientId: cfg.clientId,
      brokers: cfg.brokers,
      ssl: cfg.ssl,
      ...(cfg.sasl ? { sasl: cfg.sasl as SASLOptions } : {}),
      logLevel: logLevel.WARN,
      retry: { initialRetryTime: 300, retries: 8 },
    });
  }
  return kafka;
}

export function topics() {
  return kafkaConfig().topics;
}

export async function createProducer(): Promise<Producer> {
  // Not using idempotent: true (needs extra ACLs); consumers are idempotent instead (invariant I-6).
  const producer = getKafka().producer({ allowAutoTopicCreation: false });
  await producer.connect();
  return producer;
}
