import { Router } from 'express';
import { visitorId } from '../domain/activity.js';

/**
 * GET /api/experiments/config: what the browser needs to start Flagsmith (web/src/experiments.ts).
 *
 * - environmentKey: Flagsmith's client-side environment key. It is public by design (it ships to
 *   every browser), so it is served at runtime instead of baked into the build: one image can point
 *   at any Flagsmith environment, and leaving FLAGSMITH_ENVIRONMENT_KEY unset turns experiments off.
 * - identity: the same one-way visitor hash our own activity events use, so Flagsmith's buckets and
 *   ClickHouse's clickstream line up. It hangs off the browser's session cookie (not the account),
 *   so a shopper keeps their variant when they sign in halfway through a visit.
 */
export const experiments = Router();

experiments.get('/experiments/config', (req, res) => {
  const environmentKey = process.env.FLAGSMITH_ENVIRONMENT_KEY?.trim() || null;
  const sid = req.cookies?.sh_sid as string; // always set by the session middleware in app.ts
  res.set('Cache-Control', 'private, no-store');
  res.json({
    environmentKey,
    identity: visitorId(sid),
    // Only for self-hosted Flagsmith; Flagsmith Cloud needs neither.
    apiUrl: process.env.FLAGSMITH_API_URL?.trim() || null,
    eventsUrl: process.env.FLAGSMITH_EVENTS_URL?.trim() || null,
  });
});
