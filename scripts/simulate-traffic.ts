/**
 * Simulated shoppers for the product_trust_signal experiment (doc/experiment.md).
 *
 * Each simulated shopper is a fresh Flagsmith identity (prefixed "sim-", trait simulated=true, so
 * they can be told apart from real shoppers). It asks Flagsmith for its variant, which records
 * the exposure exactly as the product page does, then converts with the probability given for
 * that variant and sends the same events the store sends.
 *
 * IMPORTANT: the conversion rates are inputs, not findings. The result Flagsmith reports for
 * simulated traffic shows that the pipeline works (bucketing, exposures, events, statistics) and
 * how much traffic a given lift needs. It says nothing about real shoppers. Always say which
 * numbers came from simulated traffic.
 *
 * Usage:
 *   npm run traffic:sim -- --visitors=600
 *   npm run traffic:sim -- --visitors=600 --rates=control:0.10,reviews:0.13,local-proof:0.115
 *   npm run traffic:sim -- --dry-run          # no Flagsmith calls; shows the plan
 * Needs FLAGSMITH_ENVIRONMENT_KEY (the same client-side key the store uses).
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createFlagsmithInstance } from '@flagsmith/flagsmith/isomorphic';

const FLAG = 'product_trust_signal';
const EVENTS = { addToCart: 'add_to_cart', checkoutStarted: 'checkout_started', checkoutCompleted: 'checkout_completed' };

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const has = (name: string) => process.argv.includes(`--${name}`);

const visitors = Number(arg('visitors') ?? 300);
const concurrency = Math.max(1, Math.min(20, Number(arg('concurrency') ?? 8)));
const dryRun = has('dry-run');
/** Probability that a shopper who saw this version adds to cart. Assumed, see the note above. */
const rates: Record<string, number> = { control: 0.1, reviews: 0.13, 'local-proof': 0.115 };
for (const pair of (arg('rates') ?? '').split(',').filter(Boolean)) {
  const [k, v] = pair.split(':');
  if (k && v && Number.isFinite(Number(v))) rates[k] = Number(v);
}
const START = 0.45; // of those who add to cart, share who press "Place order"
const COMPLETE = 0.85; // of those, share whose order is confirmed
const PRICES = [499, 799, 1299, 1499, 1999, 2499, 3499, 4999]; // rupees, like the catalogue

if (!Number.isInteger(visitors) || visitors < 1 || visitors > 5000) {
  console.error('--visitors must be 1 … 5000');
  process.exit(1);
}
const environmentID = process.env.FLAGSMITH_ENVIRONMENT_KEY?.trim();
if (!environmentID && !dryRun) {
  console.error('Set FLAGSMITH_ENVIRONMENT_KEY (or use --dry-run).');
  process.exit(1);
}

type Tally = { exposed: number; added: number; started: number; completed: number; revenue: number };
const tally: Record<string, Tally> = {};
const bump = (v: string) => (tally[v] ??= { exposed: 0, added: 0, started: 0, completed: 0, revenue: 0 });

async function shopper(): Promise<void> {
  const identity = `sim-${randomUUID()}`;
  if (dryRun) {
    const v = ['control', 'reviews', 'local-proof'][Math.floor(Math.random() * 3)]!;
    act(v, () => {});
    return;
  }
  const fs = createFlagsmithInstance();
  await fs.init({
    environmentID: environmentID!,
    identity,
    traits: { simulated: true },
    enableEvents: true,
    cacheFlags: false,
  });
  const flag = fs.getExperimentFlag(FLAG); // records the exposure, like useVariant() on the product page
  if (!flag?.experiment?.inExperiment) return; // not enrolled (rollout below 100%, or no experiment running)
  const variant = flag.variant ?? 'control';
  act(variant, (event, value) => fs.trackEvent(event, value === undefined ? undefined : { value }));
  await fs.flushEvents();
}

function act(variant: string, send: (event: string, value?: number) => void) {
  const t = bump(variant);
  t.exposed++;
  if (Math.random() >= (rates[variant] ?? rates.control!)) return;
  t.added++;
  send(EVENTS.addToCart);
  if (Math.random() >= START) return;
  t.started++;
  send(EVENTS.checkoutStarted);
  if (Math.random() >= COMPLETE) return;
  const value = PRICES[Math.floor(Math.random() * PRICES.length)]!;
  t.completed++;
  t.revenue += value;
  send(EVENTS.checkoutCompleted, value);
}

async function main() {
  console.log(`${dryRun ? '[dry run] ' : ''}${visitors} simulated shoppers, ${concurrency} at a time`);
  console.log(`assumed add-to-cart rates: ${Object.entries(rates).map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`).join(' · ')}`);
  let next = 0;
  let failed = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < visitors) {
        next++;
        try {
          await shopper();
        } catch (e) {
          failed++;
          if (failed <= 3) console.warn('shopper failed:', e instanceof Error ? e.message : e);
        }
      }
    }),
  );
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)} s${failed ? ` · ${failed} failed` : ''}`);
  console.table(
    Object.fromEntries(
      Object.entries(tally).map(([v, t]) => [v, {
        exposed: t.exposed,
        'add to cart': t.added,
        'add rate': `${((t.added / Math.max(1, t.exposed)) * 100).toFixed(1)}%`,
        'checkout started': t.started,
        orders: t.completed,
        'revenue ₹': t.revenue,
      }]),
    ),
  );
  if (!dryRun && Object.keys(tally).length === 0) {
    console.log('No shopper was enrolled. Is the experiment started, and is the rollout above 0%?');
  }
}

main().catch((e) => {
  console.error('traffic:sim failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
