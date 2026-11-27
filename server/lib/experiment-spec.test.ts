import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXPERIMENT, METRICS } from './experiment-spec.js';

// The browser code is the source of truth for what is actually sent to Flagsmith. Read it as text
// (it imports React) and check the setup script would create metrics for exactly those names.
const web = readFileSync(new URL('../../web/src/experiments.tsx', import.meta.url), 'utf8');
const quoted = (block: RegExp) => [...(web.match(block)?.[1] ?? '').matchAll(/:\s*'([a-z_]+)'/g)].map((m) => m[1]);

describe('experiment spec matches web/src/experiments.tsx', () => {
  it('uses the same flag name', () => {
    expect(quoted(/export const FLAGS = \{([\s\S]*?)\} as const/)).toEqual([EXPERIMENT.flag]);
  });

  it('uses the same variant labels', () => {
    const variants = web.match(/TRUST_VARIANTS = \[([^\]]*)\]/)?.[1];
    expect(variants?.match(/'([^']+)'/g)?.map((v) => v.slice(1, -1))).toEqual([...EXPERIMENT.variants]);
  });

  it('has a metric for every event the store sends, and no others', () => {
    const sent = quoted(/export const EVENTS = \{([\s\S]*?)\} as const/).sort();
    const measured = [...new Set(METRICS.map((m) => m.event))].sort();
    expect(measured).toEqual(sent);
  });

  it('puts the primary metric first', () => {
    expect(METRICS[0]).toMatchObject({ event: 'add_to_cart', role: 'primary' });
  });
});
