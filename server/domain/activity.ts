import { createHash } from 'node:crypto';
import { z } from 'zod';
import { analyticsConfig } from '../config.js';
import { getPool } from '../lib/db.js';
import { EventType } from '../lib/events.js';
import { OUTBOX_CHANNEL } from './stock.js';

/**
 * Shopper clickstream (doc/14). The browser batches events and posts them here; we write them to the
 * outbox in one statement, so they reach Kafka (topic user.activity) through the same relay as every
 * other event. The Vercel API still never talks to Kafka.
 *
 * Privacy: no names, emails, phone numbers or typed form values. The session cookie is the cart key,
 * so it is never stored; only a one-way hash, enough to count distinct visitors and follow a journey.
 */
export const ACTIVITY_TYPES = ['page_view', 'product_presence', 'click', 'search', 'sold_out_seen', 'api_error'] as const;

const Text = (max: number) => z.string().trim().max(max);

export const ActivityEvent = z.object({
  type: z.enum(ACTIVITY_TYPES),
  at: z.number().int().positive(), // client clock, ms
  path: Text(200),
  city: z.string().max(3).optional(),
  label: Text(80).optional(), // clicked button/link text or data-track name
  productId: z.number().int().positive().optional(),
  q: Text(80).optional(),
  results: z.number().int().nonnegative().optional(),
  code: Text(40).optional(),
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

export const ActivityBatch = z.object({ events: z.array(ActivityEvent).min(1).max(50) });

export const visitorId = (sessionId: string) => createHash('sha256').update(`stockhop:${sessionId}`).digest('hex').slice(0, 16);

/** Drops anything that looks like contact details from free text (defence in depth: the client already avoids form values). */
const scrub = (s: string | undefined) =>
  s?.replace(/\S+@\S+/g, '[email]').replace(/\+?\d[\d\s-]{6,}\d/g, '[number]');

export async function recordActivity(sessionId: string, events: ActivityEvent[]): Promise<number> {
  const visitor = visitorId(sessionId);
  const now = Date.now();
  const rows = events.map((e) => ({
    ...e,
    label: scrub(e.label),
    q: scrub(e.q),
    // Trust the client clock only within 10 minutes; otherwise use the server's.
    at: new Date(Math.abs(now - e.at) < 600_000 ? e.at : now).toISOString(),
    visitor,
  }));
  const { topic } = analyticsConfig();
  const r = await getPool().query<{ n: string }>(
    `WITH ev AS (
       INSERT INTO outbox (topic, msg_key, event_type, payload)
       SELECT $1, $2, $3, e FROM jsonb_array_elements($4::jsonb) AS e
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM ev) AS n, pg_notify($5, '')`,
    [topic, visitor, EventType.UserActivity, JSON.stringify(rows), OUTBOX_CHANNEL],
  );
  return Number(r.rows[0]?.n ?? 0);
}
