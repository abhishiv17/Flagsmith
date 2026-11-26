/**
 * CP1 gate: proves this machine can reach all three Aiven services.
 * Usage: npm run smoke   (each check is independent; prints ✅/❌ per service)
 */
import { randomUUID } from 'node:crypto';
import { getPool, closePool } from '../server/lib/db.js';
import { getSearch } from '../server/lib/search.js';
import { getKafka, topics } from '../server/lib/kafka.js';

type Result = { name: string; ok: boolean; detail: string; ms: number };

async function timed(name: string, fn: () => Promise<string>): Promise<Result> {
  const t0 = Date.now();
  try {
    return { name, ok: true, detail: await fn(), ms: Date.now() - t0 };
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
  }
}

async function checkPostgres() {
  const { rows } = await getPool().query<{ v: string }>('SELECT version() AS v');
  return rows[0]?.v.split(',')[0] ?? 'connected';
}

async function checkOpenSearch() {
  const res = await getSearch().cluster.health();
  const body = res.body as { status?: string; number_of_nodes?: number };
  return `cluster ${body.status ?? '?'} · ${body.number_of_nodes ?? '?'} node(s)`;
}

/** Produce a unique message to the smoke topic and wait until a fresh consumer receives it. */
async function checkKafka() {
  const kafka = getKafka();
  const topic = topics().smoke;
  const token = randomUUID();
  const consumer = kafka.consumer({ groupId: `smoke-${token}` });
  const producer = kafka.producer();
  try {
    await Promise.all([consumer.connect(), producer.connect()]);
    await consumer.subscribe({ topic, fromBeginning: false });

    const received = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no message back within 30s on "${topic}"`)), 30_000);
      consumer
        .run({
          eachMessage: async ({ message }) => {
            if (message.value?.toString() === token) {
              clearTimeout(timer);
              resolve();
            }
          },
        })
        .catch(reject);
    });
    // Wait for partition assignment before producing, or the message lands before we're listening.
    await new Promise<void>((resolve) => {
      const off = consumer.on(consumer.events.GROUP_JOIN, () => {
        off();
        resolve();
      });
    });
    await producer.send({ topic, messages: [{ key: 'smoke', value: token }] });
    await received;
    return `round-trip via "${topic}" ok`;
  } finally {
    await Promise.allSettled([consumer.disconnect(), producer.disconnect()]);
  }
}

async function main() {
  const results = await Promise.all([
    timed('PostgreSQL', checkPostgres),
    timed('OpenSearch', checkOpenSearch),
    timed('Kafka', checkKafka),
  ]);
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name.padEnd(11)} ${String(r.ms).padStart(6)} ms  ${r.detail}`);
  }
  await closePool();
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main();
