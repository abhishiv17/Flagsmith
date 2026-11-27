import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit.js';

describe('RateLimiter', () => {
  it('allows up to the limit, then reports seconds until the window resets', () => {
    let t = 0;
    const rl = new RateLimiter({ limit: 3, windowMs: 60_000 }, () => t);
    expect([rl.hit('a'), rl.hit('a'), rl.hit('a')]).toEqual([0, 0, 0]);
    t = 15_000;
    expect(rl.hit('a')).toBe(45);
  });

  it('counts each key separately', () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 1000 }, () => 0);
    expect(rl.hit('a')).toBe(0);
    expect(rl.hit('b')).toBe(0);
    expect(rl.hit('a')).toBeGreaterThan(0);
  });

  it('starts a fresh window once the old one has passed', () => {
    let t = 0;
    const rl = new RateLimiter({ limit: 1, windowMs: 1000 }, () => t);
    rl.hit('a');
    expect(rl.hit('a')).toBeGreaterThan(0);
    t = 1000;
    expect(rl.hit('a')).toBe(0);
  });
});
