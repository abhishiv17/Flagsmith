import express, { type NextFunction, type Request, type Response } from 'express';
import { cacheHealth } from './lib/cache.js';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getPool, isDbBusy } from './lib/db.js';
import { getSearch } from './lib/search.js';
import { HttpError } from './lib/http.js';
import { log, errMsg } from './lib/log.js';
import { catalog } from './routes/catalog.js';
import { shop } from './routes/shop.js';
import { ops } from './routes/ops.js';
import { paymentsTest } from './routes/payments-test.js';
import { track } from './routes/track.js';
import { analytics } from './routes/analytics.js';
import { retailer } from './routes/retailer.js';
import { accounts } from './routes/accounts.js';
import { shopDashboard } from './routes/shop-dashboard.js';

/**
 * The Express app. Talks to PostgreSQL and OpenSearch only, never Kafka (doc/03 §2).
 * - Local dev: server/dev.ts (API only; Vite serves the UI).
 * - Aiven Runtime / any container: server/main.ts with `staticDir` → one process serves UI + API.
 * - Vercel (fallback): api/index.ts.
 */
export function createApp(opts: { staticDir?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Aiven Runtime / Vercel TLS termination
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());

  // Guest session cookie: carts hang off it (ADR-5).
  app.use((req, res, next) => {
    if (!req.cookies?.sh_sid) {
      const sid = randomUUID();
      req.cookies = { ...req.cookies, sh_sid: sid };
      res.cookie('sh_sid', sid, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.secure,
        maxAge: 30 * 24 * 3600 * 1000,
      });
    }
    next();
  });

  app.get('/api/health', async (_req, res) => {
    // Wrapped in async fns so a missing env var reports "down" instead of throwing.
    const [pg, os] = await Promise.allSettled([
      (async () => getPool().query('SELECT 1'))(),
      (async () => getSearch().cluster.health())(),
    ]);
    const status = {
      postgres: pg.status === 'fulfilled' ? 'up' : 'down',
      opensearch: os.status === 'fulfilled' ? 'up' : 'down',
    };
    // Valkey is an optional cache: reported, but never fails the health check (the shop falls back to OpenSearch).
    res.status(Object.values(status).every((s) => s === 'up') ? 200 : 503).json({ ...status, valkey: await cacheHealth() });
  });

  app.use('/api', catalog, shop, ops, paymentsTest, track, analytics, retailer, shopDashboard, accounts);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } });
  });

  // Single-container deploys: serve the built storefront and fall back to index.html for SPA routes.
  if (opts.staticDir && existsSync(opts.staticDir)) {
    app.use(express.static(opts.staticDir, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(opts.staticDir!, 'index.html')));
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      if (err.status >= 500) log.warn('request failed', { path: req.path, code: err.code, err: err.message });
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    // Malformed JSON body from express.json()
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'Malformed JSON' } });
      return;
    }
    // Database full (all connection slots taken) or pool wait timed out: nothing ran, so the
    // client may safely retry. 503 + Retry-After instead of a generic 500 (doc/12 F1).
    if (isDbBusy(err)) {
      log.warn('database busy', { path: req.path, err: errMsg(err) });
      res.set('Retry-After', '1');
      res.status(503).json({ error: { code: 'BUSY', message: 'StockHop is busy right now. Please try again in a moment.' } });
      return;
    }
    // Last resort: never leak stack traces or connection details.
    log.error('unhandled', { path: req.path, err: errMsg(err) });
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });

  return app;
}
