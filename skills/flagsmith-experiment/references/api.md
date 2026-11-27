# Flagsmith Experimentation API bodies

Paths are relative to the Flagsmith API (`flagsmith api` adds the host and credentials). `$ENV` is the environment key. Send a body with `-X POST --input -` and a heredoc, or `--input file.json`.

## Warehouse

`GET api/v1/environments/$ENV/warehouse-connections/`: must list at least one connection. Without one, events are rejected and experiments can't be created.

## Metric

`POST api/v1/environments/$ENV/experiment-metrics/`

```json
{ "name": "Add to cart", "aggregation": "occurrence", "direction": "up", "definition": { "version": 1, "event": "add_to_cart" } }
```

- `aggregation`: `occurrence` (did the identity do it at least once; conversion rate), `count` (how many times), `sum` (total of `value`, e.g. revenue), `mean` (average `value`).
- `direction`: `up` or `down` (which way is better).
- `event`: exactly the name the code sends. Case-sensitive. An event with no matching metric is dropped silently.
- A revenue guardrail is a second metric on the same event with `"aggregation": "sum"`. The code must send `value` with the event.

## Experiment

`POST api/v1/environments/$ENV/experiments/`

```json
{
  "feature": 123,
  "name": "Reviews on the product page",
  "hypothesis": "Showing reviews raises add-to-cart by at least 10%.",
  "metrics": [
    { "metric": 11, "expected_direction": "increase" },
    { "metric": 14, "expected_direction": "increase" }
  ],
  "experiment_rollout": {
    "enabled": true,
    "rollout_percentage": 100,
    "feature_state_value": { "type": "string", "value": "control" },
    "multivariate_feature_state_values": [
      { "multivariate_feature_option": 456, "percentage_allocation": 50 }
    ]
  }
}
```

- `feature`: the flag id. `multivariate_feature_option`: a variation id (step 3).
- Each variation gets `percentage_allocation`; control gets the rest. For three arms, use 33/33 (control 34).
- `rollout_percentage`: the share of identities enrolled. Keep it at 100 unless the user wants a holdout.
- Creating it doesn't start it.

## Start

`POST api/v1/environments/$ENV/experiments/<id>/start/`: locks the flag and turns on the split. Status becomes `running`.

## Results

- `POST api/v1/environments/$ENV/experiments/<id>/results/refresh/`: recompute. At most once every 5 minutes (a 429 means wait; read the last results).
- `GET api/v1/environments/$ENV/experiments/<id>/results/`: the current results, shaped like this (trimmed):

```json
{ "results": { "as_of": "…", "is_final": false, "payload": {
  "srm_p_value": null,
  "metrics": [ { "metric_id": 1516,
    "variants":  { "control": { "n": 2007, "sum": 216 }, "reviews": { "n": 2043, "sum": 268 } },
    "inference": { "reviews": { "lift": 0.219, "ci_low": 0.014, "ci_high": 0.424, "chance_to_win": 0.982 } } } ] } } }
```

`n` is identities exposed, and `sum` is conversions (occurrence) or the summed `value` (sum). Rate = `sum / n`. `inference` has one entry per non-control variant. `srm_p_value` below 0.001 means the split is broken.

How to read them:
- **Exposures** are counted once per identity, in the first variant it saw. Identities seen in more than one variant are quarantined.
- **Lift** is the relative change against control.
- **95% credible interval**: if it crosses 0, the result is inconclusive.
- **Win probability (chance to beat control)**: above 95% is winning, below 5% is losing, anything between is inconclusive.
- **Sample-ratio mismatch** is flagged from 100 identities. Don't act on results while it fires.
- **Collecting data** until every arm has at least 50 identities and, for conversion metrics, 5 conversions.

## End and roll out

Use the dashboard: **End experiment** → choose control, a variation, or off. The choice becomes the flag's environment default, results freeze and the flag unlocks. No API for this is documented.
