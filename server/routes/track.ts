import { Router } from 'express';
import { parse } from '../lib/http.js';
import { shopperKey } from '../domain/accounts.js';
import { ActivityBatch, recordActivity } from '../domain/activity.js';

/** POST /api/track: batched shopper activity from web/src/track.ts (sendBeacon). Fire-and-forget for the browser. */
export const track = Router();

track.post('/track', async (req, res) => {
  // sendBeacon sends text/plain to avoid a CORS preflight, so the JSON may arrive as a string.
  const body: unknown = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  const { events } = parse(ActivityBatch, body);
  // Signed in: the account key, so one shopper's journey is one visitor across devices (still a hash).
  const n = await recordActivity(await shopperKey(req), events);
  res.status(202).json({ accepted: n });
});
