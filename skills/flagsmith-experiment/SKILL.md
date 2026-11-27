---
name: flagsmith-experiment
description: Run a complete A/B test with Flagsmith Experimentation through the Flagsmith CLI. Checks the warehouse, creates a multivariate flag with keyed variations, conversion metrics and the experiment, wires exposure and conversion events into the code, starts it after approval, reads lift and win probability, and guides the rollout of the winner with the same flag. Use when the user wants to A/B test something, find out which version wins, set up a Flagsmith experiment, or read or act on experiment results.
compatibility: Needs the Flagsmith CLI v2 or later, a Flagsmith environment with a connected warehouse, and an app on a Flagsmith SDK with Experimentation support (JS/React 12.4.0+, Node 9.1.0+, Python 6.3.0+, Java 8.2.0+, Go v5.3.0+, Flutter 6.2.0+).
metadata:
  author: Team Dark Launchers
  version: "1.0"
---

# Flagsmith experiment, end to end

You take the user from "I want to test X" to a decided, rolled-out experiment. Use only the `flagsmith` CLI (`flagsmith api` for endpoints without a command). Don't use the Flagsmith MCP server: it can't start experiments.

## Safety rules (never skip)

1. **Nothing changes without an approved plan.** Show the plan (step 2) and wait for a yes.
2. **Ask again before each state change**: create, start and end. If the environment name matches `prod|production|live|main`, the user must type the environment name to confirm.
3. **Never touch a running experiment's flag or rollout.** Flags are locked while it runs, and changing the rollout invalidates the result.
4. **Keys:** only the client-side environment key may go in browser code. Admin credentials stay in the CLI or `.env`, never in code, commits or output you print.
5. **Decide by the rule you write down in step 1**, not by what the data looks like later. Say "inconclusive" when it is.

## Token discipline

- Add `--jq` to every call so you read only the ids and fields you need.
- Run each command once. Don't list projects or flags again once `flagsmith.json` exists.
- Open `references/` files only at the step that names them.
- Write each step's report in at most 3 lines.

## Workflow

`$ENV` is the environment key. `$FLAG` is the flag name.

### 0. Pre-flight
```bash
flagsmith --version                       # must be v2+
flagsmith config                          # project/environment already bound?
# if not: flagsmith login && flagsmith project list && flagsmith environment list --project <p>
#         flagsmith init --project <p> --environment $ENV
flagsmith api api/v1/environments/$ENV/warehouse-connections/ --jq 'length'
```
If no warehouse is connected, stop: the user must connect one (Environment settings → Warehouse), because events are rejected until then. Find the SDK and version in the lockfile. If it is below the version in `compatibility`, stop.

### 1. Brief (one message, four questions)
Ask: what changes between versions (variant names; `control` is reserved for the current one); the success event (`snake_case`; reuse an existing one if the code already sends it); the hypothesis, including the smallest lift worth shipping; and the decision rule (default: ship at ≥ 95% win probability on the primary metric, otherwise keep control). Repeat the answers back in 3 lines.

### 2. Plan and approval
Print every change, grouped by environment: the flag and variants with their keys, the metrics (event, aggregation, direction), the experiment (split, primary metric) and the code files to touch. **Wait for approval.**

### 3. Flag with keyed variants
```bash
flagsmith feature create $FLAG --value control --enabled
flagsmith feature variant add $FLAG --value <variant> --key <variant> --weight 0   # once per variant
flagsmith feature get $FLAG --json --jq '{id, variants: [.multivariate_options[] | {id, key}]}'
```
Every variation needs `--key`: a variation without one is never counted. If the flag already exists, ask before changing it.

### 4. Metrics
Search the code for event names already sent (`trackEvent(` / `track_event(`) and warn about any mismatch: names are case-sensitive. For each metric, POST the body from `references/api.md#metric` and keep the returned `.id`.
```bash
flagsmith api api/v1/environments/$ENV/experiment-metrics/ -X POST --input - --jq .id <<'JSON'
{"name":"Add to cart","aggregation":"occurrence","direction":"up","definition":{"version":1,"event":"add_to_cart"}}
JSON
```

### 5. Experiment (not started)
Show the body from `references/api.md#experiment` and POST it to `api/v1/environments/$ENV/experiments/` with `--jq '{id, status}'`. Put the primary metric first. Don't start it yet.

### 6. Code
Open `references/sdk-snippets.md` for the user's SDK. The rules:
- Identify the user **before** asking for the experiment flag, and use the same identity for the flag and the events.
- Request the experiment flag **only in the component that shows the difference**: that request records the exposure.
- Send conversions at the real moment of success. Flush buffered events before a short-lived process exits.
- Fail safe: if Flagsmith is unreachable, render control.

Show the patch and get approval before writing it. Run the project's typecheck and tests.

### 7. Start
Confirm (rule 2), then:
```bash
flagsmith api api/v1/environments/$ENV/experiments/<id>/start/ -X POST --jq .status
```
It must report `running`. Tell the user the flag is now locked.

### 8. Verify traffic
Ask the user to load the page as two identities, or send test traffic. Wait about a minute, then refresh the results (step 9). If there are no exposures or conversions after 10 minutes, open `references/troubleshooting.md`.

### 9. Results
```bash
flagsmith api api/v1/environments/$ENV/experiments/<id>/results/refresh/ -X POST   # max once per 5 minutes
flagsmith api api/v1/environments/$ENV/experiments/<id>/results/ --jq '.results | {as_of, is_final, srm: .payload.srm_p_value, metrics: [.payload.metrics[] | {metric_id, n: (.variants | map_values({n, sum})), vs_control: .inference}]}'
```
`metric_id` maps to the metric ids from step 4. `vs_control.<variant>` holds `lift`, `ci_low`, `ci_high` and `chance_to_win` (0 to 1). Report in at most 6 lines: exposures per variant (check the split is roughly even; a sample-ratio warning means don't act), the primary metric's rate per variant, lift, the 95% credible interval, win probability, and the guardrails. "Collecting data" until every arm has 50 identities and 5 conversions.

### 10. Decide and roll out
Apply the rule from step 1 word for word. Then the user ends it in the dashboard: **Experiment → End experiment →** choose what the flag serves (the winner, or control). That serves the winner to everyone with the same flag, no deploy needed. Flagsmith documents no API for this step, so give the user those clicks rather than guessing an endpoint. Finally, offer a clean-up patch that removes the losing code path and the flag check, and remind the user to delete the flag once the change is permanent.

## Done when
The experiment is ended with a decision recorded against the rule, the winner is served by the flag, and the clean-up is either merged or scheduled.
