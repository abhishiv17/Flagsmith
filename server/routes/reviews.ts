import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../lib/db.js';
import { CityCode, HttpError, parse } from '../lib/http.js';
import { visitorId } from '../domain/activity.js';
import { RateLimiter } from '../lib/rate-limit.js';

/**
 * Product reviews: the "reviews" version of the product_trust_signal experiment (doc/experiment.md).
 *   GET  /api/products/:id/reviews  average, count and the latest reviews
 *   POST /api/products/:id/reviews  one review per browser per product
 *
 * The store link is public during the experiment, so posting is rate limited per browser and per
 * IP address. Otherwise one person could flood the reviews version and skew what it shows.
 */
export const reviews = Router();

export type ReviewSummary = {
  average: number | null; // 1 decimal place; null when there are no reviews
  count: number;
  /** How many reviews gave 5, 4, 3, 2 and 1 stars, in that order. */
  breakdown: [number, number, number, number, number];
  reviews: { id: number; rating: number; body: string; authorName: string; city: string | null; createdAt: string }[];
  /** True when this browser has already reviewed the product. */
  yours: boolean;
};

const Params = z.object({ id: z.coerce.number().int().positive() });

export async function reviewSummary(productId: number, sid: string): Promise<ReviewSummary> {
  const pool = getPool();
  const [agg, latest] = await Promise.all([
    pool.query<{ n: string; avg: string | null; r5: string; r4: string; r3: string; r2: string; r1: string; yours: boolean }>(
      `SELECT count(*) AS n, round(avg(rating)::numeric, 1) AS avg,
              count(*) FILTER (WHERE rating = 5) AS r5, count(*) FILTER (WHERE rating = 4) AS r4,
              count(*) FILTER (WHERE rating = 3) AS r3, count(*) FILTER (WHERE rating = 2) AS r2,
              count(*) FILTER (WHERE rating = 1) AS r1,
              bool_or(author_key = $2) IS TRUE AS yours
         FROM product_reviews WHERE product_id = $1`,
      [productId, visitorId(sid)],
    ),
    pool.query<{ id: string; rating: number; body: string; author_name: string; city_code: string | null; created_at: Date }>(
      `SELECT id, rating, body, author_name, city_code, created_at
         FROM product_reviews WHERE product_id = $1
        ORDER BY created_at DESC, id DESC LIMIT 6`,
      [productId],
    ),
  ]);
  const a = agg.rows[0]!;
  return {
    average: a.avg === null ? null : Number(a.avg),
    count: Number(a.n),
    breakdown: [Number(a.r5), Number(a.r4), Number(a.r3), Number(a.r2), Number(a.r1)],
    reviews: latest.rows.map((r) => ({
      id: Number(r.id), rating: r.rating, body: r.body, authorName: r.author_name, city: r.city_code, createdAt: r.created_at.toISOString(),
    })),
    yours: a.yours,
  };
}

reviews.get('/products/:id/reviews', async (req, res) => {
  const { id } = parse(Params, req.params);
  res.set('Cache-Control', 'private, no-store');
  res.json(await reviewSummary(id, req.cookies.sh_sid as string));
});

const NewReview = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().trim().min(10, 'Write at least 10 characters').max(500),
  name: z.string().trim().min(1, 'Add a name to show with your review').max(40),
  city: CityCode.optional(),
});

/** Drops anything that looks like contact details: reviews are public. */
const scrub = (s: string) => s.replace(/\S+@\S+/g, '[email]').replace(/\+?\d[\d\s-]{6,}\d/g, '[number]');

const HOUR = 60 * 60 * 1000;
const perBrowser = new RateLimiter({ limit: 5, windowMs: HOUR });
const perAddress = new RateLimiter({ limit: 20, windowMs: HOUR });

reviews.post('/products/:id/reviews', async (req, res) => {
  const { id } = parse(Params, req.params);
  const r = parse(NewReview, req.body);
  const sid = req.cookies.sh_sid as string;
  const wait = perBrowser.hit(visitorId(sid)) || perAddress.hit(req.ip ?? 'unknown');
  if (wait) {
    res.set('Retry-After', String(wait));
    throw new HttpError(429, 'RATE_LIMITED', 'You’ve posted a lot of reviews in the last hour. Try again later.');
  }
  const ins = await getPool().query(
    `INSERT INTO product_reviews (product_id, rating, body, author_name, city_code, author_key)
     SELECT $1, $2, $3, $4, $5, $6 WHERE EXISTS (SELECT 1 FROM products WHERE id = $1)
     ON CONFLICT (product_id, author_key) DO NOTHING
     RETURNING id`,
    [id, r.rating, scrub(r.body), scrub(r.name), r.city ?? null, visitorId(sid)],
  );
  if (!ins.rowCount) {
    const exists = await getPool().query('SELECT 1 FROM products WHERE id = $1', [id]);
    if (!exists.rowCount) throw new HttpError(404, 'NOT_FOUND', 'Product not found');
    throw new HttpError(409, 'ALREADY_REVIEWED', 'You have already reviewed this product.');
  }
  res.status(201).json(await reviewSummary(id, sid));
});
