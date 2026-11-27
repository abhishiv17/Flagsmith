/**
 * A small fixed-window rate limiter for public write endpoints (reviews).
 *
 * Counts live in this process's memory. That is enough for one web instance; with several, each
 * keeps its own count, so the effective limit is (limit × instances), which is still a hard cap
 * on spam. Windows are dropped once they expire, so memory stays bounded by active keys.
 */
export type Limit = { limit: number; windowMs: number };

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly opts: Limit, private readonly now: () => number = Date.now) {}

  /**
   * Records one hit for `key`. Returns 0 when allowed, otherwise the seconds until the window
   * resets (for a Retry-After header).
   */
  hit(key: string): number {
    const t = this.now();
    if (this.hits.size > 10_000) this.sweep(t);
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.opts.windowMs });
      return 0;
    }
    if (cur.count >= this.opts.limit) return Math.max(1, Math.ceil((cur.resetAt - t) / 1000));
    cur.count++;
    return 0;
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
