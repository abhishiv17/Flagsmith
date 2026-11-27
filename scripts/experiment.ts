/**
 * Set up, start and read the product_trust_signal experiment through the Flagsmith Admin API.
 * Same requests as Flagsmith's coding-agent guide (doc/flagsmith.md), as one repeatable command.
 *
 *   npm run exp -- check   --env=prod|sim   warehouse, flag, keyed variation, metrics, experiment
 *   npm run exp -- setup   --env=prod|sim   create missing metrics + the experiment (NOT started)
 *   npm run exp -- start   --env=prod|sim   start it (locks the flag; asks unless --yes)
 *   npm run exp -- results --env=prod|sim   refresh (max once per 5 min) and print the results
 *        --write   also save the raw JSON to doc/results/ and add a dated entry to doc/results.md
 *   --dry-run      print every request instead of sending it (no keys needed)
 *
 * The flag itself is created with the Flagsmith CLI first (doc/flagsmith.md, step 3), because the
 * CLI sets the variation key the experiment needs:
 *   flagsmith feature create product_trust_signal --value control --enabled
 *   flagsmith feature variant add product_trust_signal --value reviews --key reviews --weight 0
 *
 * Environments:  prod → FLAGSMITH_ENVIRONMENT_KEY (the live store)
 *                sim  → FLAGSMITH_SIM_ENVIRONMENT_KEY (simulated shoppers only)
 * Auth:          FLAGSMITH_API_KEY, an Organisation API key (Organisation settings → API keys).
 *                Admin access: keep it in .env, never in the browser, never in git.
 * Self-hosted:   FLAGSMITH_ADMIN_API_URL (default https://api.flagsmith.com/).
 *
 * Ending the experiment and rolling out the winner is done in the dashboard ("End experiment" →
 * choose what the flag serves). Flagsmith doesn't document an API for it, so this script doesn't
 * guess one.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { EXPERIMENT, METRICS, type MetricSpec } from '../server/lib/experiment-spec.js';

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) ?? 'help';
const opt = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const has = (name: string) => args.includes(`--${name}`);
const dryRun = has('dry-run');
const envName = opt('env') ?? 'prod';

const BASE = (process.env.FLAGSMITH_ADMIN_API_URL?.trim() || 'https://api.flagsmith.com/').replace(/\/?$/, '/');

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

function envKey(): string {
  const v = envName === 'sim' ? 'FLAGSMITH_SIM_ENVIRONMENT_KEY' : envName === 'prod' ? 'FLAGSMITH_ENVIRONMENT_KEY' : null;
  if (!v) fail(`--env must be prod or sim (got "${envName}")`);
  const key = process.env[v]?.trim();
  if (!key) {
    if (dryRun) return `<${v}>`;
    fail(`${v} is not set in .env`);
  }
  if (envName === 'sim' && key === process.env.FLAGSMITH_ENVIRONMENT_KEY?.trim()) {
    fail('FLAGSMITH_SIM_ENVIRONMENT_KEY equals the live store key. Use the Simulation environment.');
  }
  return key;
}

class ApiFailure extends Error {
  constructor(public status: number, public body: string, msg: string) {
    super(msg);
  }
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Json> {
  if (dryRun) {
    console.log(`\n→ ${method} ${BASE}${path}`);
    if (body !== undefined) console.log(JSON.stringify(body, null, 2));
    return null;
  }
  const apiKey = process.env.FLAGSMITH_API_KEY?.trim();
  if (!apiKey) fail('FLAGSMITH_API_KEY (Organisation API key) is not set in .env');
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Api-Key ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiFailure(res.status, text, `${method} ${path} → ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

/** Flagsmith list endpoints are either an array or a paginated { results: [] }. */
const list = (j: Json): Json[] => (Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : []);

type Ctx = {
  key: string;
  projectId: number | string;
  feature: Json | null;
  variation: Json | null;
  metrics: Json[];
  experiment: Json | null;
};

async function load(key: string): Promise<Ctx> {
  const env = await call('GET', `api/v1/environments/${key}/`);
  const projectId = env?.project ?? '<project id>';
  const feats = list(await call('GET', `api/v1/projects/${projectId}/features/?search=${EXPERIMENT.flag}`));
  const feature = feats.find((f) => f.name === EXPERIMENT.flag) ?? null;
  const opts: Json[] = feature?.multivariate_options ?? [];
  const wanted = EXPERIMENT.variants[0];
  const variation = opts.find((o) => o.key === wanted) ?? opts.find((o) => o.string_value === wanted) ?? null;
  const metrics = list(await call('GET', `api/v1/environments/${key}/experiment-metrics/`));
  const exps = list(await call('GET', `api/v1/environments/${key}/experiments/`));
  const experiment =
    exps.find((e) => e.name === EXPERIMENT.name) ?? exps.find((e) => feature && (e.feature === feature.id || e.feature?.id === feature.id)) ?? null;
  return { key, projectId, feature, variation, metrics, experiment };
}

const metricFor = (ctx: Ctx, m: MetricSpec) =>
  ctx.metrics.find((x) => x.name === m.name) ??
  ctx.metrics.find((x) => x.definition?.event === m.event && x.aggregation === m.aggregation);

const ok = (s: string) => console.log(`  ✓ ${s}`);
const bad = (s: string) => console.log(`  ✗ ${s}`);

async function check(): Promise<Ctx> {
  const key = envKey();
  console.log(`Flagsmith ${envName === 'sim' ? 'Simulation' : 'Production'} environment, ${BASE}`);
  const wh = list(await call('GET', `api/v1/environments/${key}/warehouse-connections/`));
  if (!dryRun) wh.length ? ok(`warehouse connected (${wh.length})`) : bad('no warehouse connected: Environment settings → Warehouse. Events are rejected until then.');
  const ctx = await load(key);
  if (dryRun) return ctx;
  ctx.feature ? ok(`flag ${EXPERIMENT.flag} (id ${ctx.feature.id})`) : bad(`flag ${EXPERIMENT.flag} missing: create it with the Flagsmith CLI (see the top of this file)`);
  if (ctx.feature) {
    if (!ctx.variation) bad(`variation "${EXPERIMENT.variants[0]}" missing on the flag`);
    else if (ctx.variation.key !== EXPERIMENT.variants[0])
      bad(`variation "${EXPERIMENT.variants[0]}" (id ${ctx.variation.id}) has no key; add it with --key, or it isn't counted`);
    else ok(`variation "${ctx.variation.key}" (id ${ctx.variation.id})`);
  }
  for (const m of METRICS) {
    const found = metricFor(ctx, m);
    found ? ok(`metric "${m.name}" → ${m.event} (${m.aggregation}, id ${found.id})`) : bad(`metric "${m.name}" missing`);
  }
  if (ctx.experiment) ok(`experiment "${ctx.experiment.name}" (id ${ctx.experiment.id}), status ${ctx.experiment.status ?? 'unknown'}`);
  else bad('experiment not created yet: npm run exp -- setup');
  return ctx;
}

async function setup() {
  const ctx = await check();
  if (!dryRun && (!ctx.feature || !ctx.variation)) fail('Create the flag and its keyed variation with the Flagsmith CLI first.');
  console.log('\nCreating what is missing…');
  const ids: (number | string)[] = [];
  for (const m of METRICS) {
    const found = metricFor(ctx, m);
    if (found) {
      ids.push(found.id);
      continue;
    }
    const made = await call('POST', `api/v1/environments/${ctx.key}/experiment-metrics/`, {
      name: m.name,
      aggregation: m.aggregation,
      direction: m.direction,
      definition: { version: 1, event: m.event },
    });
    ids.push(made?.id ?? `<${m.name} metric id>`);
    if (!dryRun) ok(`created metric "${m.name}" (id ${made?.id})`);
  }
  if (ctx.experiment) {
    ok(`experiment already exists (id ${ctx.experiment.id}); not creating another`);
    return;
  }
  const exp = await call('POST', `api/v1/environments/${ctx.key}/experiments/`, {
    feature: ctx.feature?.id ?? '<flag id>',
    name: EXPERIMENT.name,
    hypothesis: EXPERIMENT.hypothesis,
    // Primary metric first, as on the experiment page. Check "primary" in the dashboard before starting.
    metrics: METRICS.map((m, i) => ({ metric: ids[i], expected_direction: m.direction === 'up' ? 'increase' : 'decrease' })),
    experiment_rollout: {
      enabled: true,
      rollout_percentage: 100,
      feature_state_value: { type: 'string', value: EXPERIMENT.control },
      // 50% to reviews; control gets the remaining 50%.
      multivariate_feature_state_values: [{ multivariate_feature_option: ctx.variation?.id ?? '<reviews variation id>', percentage_allocation: 50 }],
    },
  });
  if (!dryRun) ok(`created experiment "${EXPERIMENT.name}" (id ${exp?.id}), not started. Next: npm run exp -- start --env=${envName}`);
}

async function confirm(question: string): Promise<boolean> {
  if (has('yes') || dryRun) return true;
  if (!process.stdin.isTTY) fail(`${question} Pass --yes to confirm without a terminal.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} Type "start" to continue: `)).trim();
  rl.close();
  return a === 'start';
}

async function start() {
  const key = envKey();
  const ctx = await load(key);
  if (!dryRun && !ctx.experiment) fail('No experiment yet: npm run exp -- setup');
  const id = ctx.experiment?.id ?? '<experiment id>';
  if (!(await confirm(`Start "${EXPERIMENT.name}" in ${envName}? This locks ${EXPERIMENT.flag} and splits traffic 50/50.`))) fail('Not started.');
  const r = await call('POST', `api/v1/environments/${key}/experiments/${id}/start/`);
  if (!dryRun) ok(`started; status ${r?.status ?? (await load(key)).experiment?.status ?? 'unknown'}`);
}

/** Every leaf value in a JSON document, as "a.b[0].c = v". */
function leaves(j: Json, path = '', out: [string, unknown][] = []): [string, unknown][] {
  if (j !== null && typeof j === 'object') {
    for (const [k, v] of Object.entries(j)) leaves(v, Array.isArray(j) ? `${path}[${k}]` : path ? `${path}.${k}` : k, out);
  } else out.push([path, j]);
  return out;
}

const INTERESTING = /variant|variation|label|key|metric|event|exposure|enrol|identit|conversion|rate|lift|delta|prob|chance|interval|credible|lower|upper|mean|sum|count|status|srm|ratio|as_of|updated|winner/i;
const WIN = /(win|beat|best).*(prob|chance)|(prob|chance).*(win|beat|best)/i;

async function results() {
  const key = envKey();
  const ctx = await load(key);
  if (!dryRun && !ctx.experiment) fail('No experiment yet: npm run exp -- setup');
  const id = ctx.experiment?.id ?? '<experiment id>';
  try {
    await call('POST', `api/v1/environments/${key}/experiments/${id}/results/refresh/`);
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 429) console.log('(refreshed less than 5 minutes ago; showing the last results)');
    else throw e;
  }
  const r = await call('GET', `api/v1/environments/${key}/experiments/${id}/results/`);
  if (dryRun) return;

  const all = leaves(r);
  const shown = all.filter(([p]) => INTERESTING.test(p));
  console.log(`\n${EXPERIMENT.name} · ${envName === 'sim' ? 'SIMULATED traffic' : 'real shoppers'} · experiment ${id}`);
  for (const [p, v] of shown.slice(0, 120)) console.log(`  ${p} = ${JSON.stringify(v)}`);
  if (shown.length > 120) console.log(`  … ${shown.length - 120} more (use --write for the full JSON)`);

  const wins = all.filter(([p, v]) => WIN.test(p.split('.').pop() ?? '') && typeof v === 'number');
  console.log(`\nDecision rule: ${EXPERIMENT.decisionRule}`);
  if (wins.length) {
    console.log('Win-probability fields found (apply the rule to the add_to_cart one for "reviews"):');
    for (const [p, v] of wins) {
      const n = v as number;
      const pct = n <= 1 ? n * 100 : n;
      console.log(`  ${p} = ${pct.toFixed(1)}%${pct >= EXPERIMENT.winProbabilityToShip * 100 ? '  ← meets the 95% bar' : ''}`);
    }
  } else console.log('No win-probability field recognised: read it on the experiment page.');
  if (envName === 'sim') console.log('\nSimulated traffic: its conversion rates are inputs we chose. This proves the pipeline, not a finding.');

  if (has('write')) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    mkdirSync('doc/results', { recursive: true });
    const file = `doc/results/${envName}-${stamp}.json`;
    writeFileSync(file, JSON.stringify(r, null, 2) + '\n');
    if (!existsSync('doc/results.md')) {
      writeFileSync('doc/results.md', '# Experiment results log\n\nSnapshots written by `npm run exp -- results --write`. Simulated traffic is labelled; its rates are inputs, not findings.\n');
    }
    const lines = wins.map(([p, v]) => `- \`${p}\` = ${(((v as number) <= 1 ? (v as number) * 100 : (v as number))).toFixed(1)}%`);
    appendFileSync(
      'doc/results.md',
      `\n## ${new Date().toISOString()} · ${envName === 'sim' ? 'Simulation (simulated shoppers)' : 'Production (real shoppers)'}\n\n` +
        `Experiment ${id}, status ${ctx.experiment?.status ?? 'unknown'}. Raw response: [${file.replace('doc/', '')}](${file.replace('doc/', '')})\n\n` +
        (lines.length ? lines.join('\n') + '\n' : 'No win-probability field recognised; see the raw response.\n'),
    );
    ok(`saved ${file} and appended doc/results.md`);
  }
}

const HELP = `Usage: npm run exp -- <check|setup|start|results> [--env=prod|sim] [--dry-run] [--yes] [--write]
See the top of scripts/experiment.ts and doc/flagsmith.md.`;

const commands: Record<string, () => Promise<unknown>> = { check, setup, start, results };
const run = commands[cmd];
if (!run) {
  console.log(HELP);
  process.exit(cmd === 'help' ? 0 : 1);
}
run().catch((e) => {
  if (e instanceof ApiFailure && (e.status === 401 || e.status === 403)) {
    fail(`${e.message}\nCheck FLAGSMITH_API_KEY is an Organisation API key with access to this project.`);
  }
  fail(e instanceof Error ? e.message : String(e));
});
