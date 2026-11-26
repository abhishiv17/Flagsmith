# How StockHop uses Flagsmith

StockHop decides which version of a page a shopper sees with **Flagsmith feature flags**, and measures which version wins with **Flagsmith Experimentation**. This page covers setup, the code, and how to read and act on the results.

The experiment itself (hypothesis, versions, metrics, decision rule) is in [experiment.md](experiment.md).

## How it fits together

```mermaid
sequenceDiagram
    participant B as Shopper's browser
    participant S as StockHop server
    participant F as Flagsmith

    B->>S: GET /api/experiments/config
    S-->>B: environment key + visitor ID (hashed session)
    B->>F: identify(visitor ID), fetch flags
    F-->>B: product_trust_signal = variant for this visitor
    Note over B: Product page renders that variant<br/>useVariant() records one exposure
    B->>F: trackEvent("add_to_cart"), "checkout_started", ...
    Note over F: Experimentation joins exposures and events<br/>per identity and works out the win probability
```

1. **The server hands out the identity.** `GET /api/experiments/config` returns Flagsmith's client-side environment key and a visitor ID. The visitor ID is the same one-way hash of the session cookie that StockHop's own clickstream already uses, so Flagsmith's buckets and our analytics describe the same people. It is tied to the browser, not the account, so a shopper keeps their variant if they sign in halfway through a visit.
2. **The browser starts Flagsmith once** with that identity and `enableEvents: true`.
3. **Pages ask for a variant** with `useVariant(flag, variants)`. Calling it records the exposure, so it is called only in the component that shows the difference.
4. **Conversions are sent with `trackConversion(event)`** at the moments listed below.

If no key is set, or Flagsmith can't be reached, every shopper gets the control version and nothing is sent. The store keeps working either way.

## Code map

| File | What it does |
|---|---|
| [`server/routes/experiments.ts`](../server/routes/experiments.ts) | `GET /api/experiments/config`: environment key and visitor ID |
| [`web/src/experiments.tsx`](../web/src/experiments.tsx) | Starts Flagsmith; `ExperimentsProvider`, `useVariant`, `trackConversion`; flag and event names |
| [`web/src/main.tsx`](../web/src/main.tsx) | Wraps the app in `ExperimentsProvider` |
| [`web/src/state.tsx`](../web/src/state.tsx) | `add_to_cart` after a successful add (every add goes through here) |
| [`web/src/pages/Checkout.tsx`](../web/src/pages/Checkout.tsx) | `checkout_started` and `checkout_completed` (with the order total) |
| [`web/src/components/NotifyMe.tsx`](../web/src/components/NotifyMe.tsx) | `back_in_stock_alert` |
| [`web/src/pages/Product.tsx`](../web/src/pages/Product.tsx) | Reads `product_trust_signal` and renders control or reviews |
| [`web/src/components/Reviews.tsx`](../web/src/components/Reviews.tsx) | The reviews version; `review_submitted` |
| [`server/routes/reviews.ts`](../server/routes/reviews.ts) | `GET`/`POST /api/products/:id/reviews` |
| [`scripts/simulate-traffic.ts`](../scripts/simulate-traffic.ts) | Simulated shoppers (`npm run traffic:sim`) |

The SDK is `@flagsmith/flagsmith` 12.4.0, pinned exactly (the first version with Experimentation support).

## Flags

| Flag | Type | Variants | Where it's read |
|---|---|---|---|
| `product_trust_signal` | Multivariate | control, `reviews` | Product page |

Code branches on the **variant label**, not the value, so labels must be set on every variation in Flagsmith. A variation created through the API without a label is not counted.

## Conversion events

Event names are case-sensitive and must match the metric in Flagsmith exactly. An event with no matching metric is dropped silently.

| Event | Fired when | `value` | Suggested metric |
|---|---|---|---|
| `add_to_cart` | An item is added to the cart from anywhere (product page, card, "bought together") | none | **Occurrence, higher is better (primary)** |
| `checkout_started` | The shopper presses "Place order" (our cart or a partner shop's item) | none | Occurrence, higher is better |
| `checkout_completed` | The order is confirmed | Order total in rupees | Occurrence (conversion) and Sum (revenue), higher is better |
| `back_in_stock_alert` | A shopper asks to be told when a sold-out item is back | none | Occurrence, informational |
| `review_submitted` | A shopper posts a review (reviews version only) | Star rating | Occurrence, informational |

Flagsmith counts a conversion only after that identity's first exposure, so an add to cart before the shopper ever saw the product page doesn't count.

## Setting it up

### 1. Flagsmith account and environment
1. Create an organisation and project on [Flagsmith Cloud](https://app.flagsmith.com). Use one environment for the experiment (for example `Production`).
2. **Environment settings → Warehouse:** enable the managed **Flagsmith** warehouse. Experiments can't be created, and events are rejected, until a warehouse is connected. The first events can take a few hours to appear, so do this early.
3. Copy the environment's **client-side** SDK key.

### 2. Tell StockHop about it
Set this on the web app (Aiven App Runtime variables, or `.env` locally):

```bash
FLAGSMITH_ENVIRONMENT_KEY=<client-side environment key>
```

The key is public by design: it is sent to every browser. It is served at runtime, so changing it needs a restart, not a rebuild. `FLAGSMITH_API_URL` and `FLAGSMITH_EVENTS_URL` are only for self-hosted Flagsmith.

Steps 3 to 5 can be done in the dashboard, or with the [Flagsmith CLI](https://docs.flagsmith.com/integrating-with-flagsmith/CLI) (v2 or later) as below. The commands follow Flagsmith's [coding-agent setup guide](https://docs.flagsmith.com/experimentation/set-up-with-a-coding-agent). `<env>` is the environment key.

```bash
flagsmith login
flagsmith init --project <project> --environment <env>
flagsmith api api/v1/environments/<env>/warehouse-connections/   # must list a connection
```

### 3. Create the flag
A **multivariate** flag `product_trust_signal`, enabled, whose own value is `control` (the control version), with one variation **keyed** `reviews`. The code reads the key, and a variation without a key is not counted.

```bash
flagsmith feature create product_trust_signal --value control --enabled
flagsmith feature variant add product_trust_signal --value reviews --key reviews --weight 0
flagsmith feature get product_trust_signal --json   # note the flag id and the variation id
```

### 4. Create the metrics
One metric per row of the events table above, with the event name copied exactly. In the dashboard, or with `POST api/v1/environments/<env>/experiment-metrics/` and a body like:

```json
{ "name": "Add to cart", "aggregation": "occurrence", "direction": "up", "definition": { "version": 1, "event": "add_to_cart" } }
```

### 5. Create the experiment
Attach it to `product_trust_signal`, enrol 100% of traffic split 50/50, set `add_to_cart` as the primary metric, and copy the hypothesis from [experiment.md](experiment.md). Through the API that is `POST api/v1/environments/<env>/experiments/`:

```json
{
  "feature": "<flag id>",
  "name": "Reviews on the product page",
  "hypothesis": "Showing reviews on the product page raises add-to-cart by at least 10% over the page without reviews.",
  "metrics": [{ "metric": "<add_to_cart metric id>", "expected_direction": "increase" }],
  "experiment_rollout": {
    "enabled": true,
    "rollout_percentage": 100,
    "feature_state_value": { "type": "string", "value": "control" },
    "multivariate_feature_state_values": [
      { "multivariate_feature_option": "<reviews variation id>", "percentage_allocation": 50 }
    ]
  }
}
```

Control gets the other 50%. Start it with `POST .../experiments/<id>/start/` (or **Launch** in the dashboard) and check its status is `running`.

While an experiment runs the flag is locked. Don't change the rollout mid-test: it can invalidate the result.

## Reading the results and rolling out

On the experiment page, check the **Exposures** panel first: enrolment should match the rollout you chose, split roughly evenly. Then read lift, credible interval and **win probability** for each variant on the primary metric.

When one variant is clearly ahead (see the decision rule in [experiment.md](experiment.md)), end the experiment and roll the winner out to everyone **with the same flag**. No deploy is needed. Afterwards, remove the losing versions from the code and the flag from Flagsmith.

To refresh and read results from the CLI: `POST .../experiments/<id>/results/refresh/` (at most once every 5 minutes), then `GET .../experiments/<id>/results/`.

## Simulated traffic

```bash
npm run traffic:sim -- --visitors=600
npm run traffic:sim -- --visitors=600 --rates=control:0.10,reviews:0.13
npm run traffic:sim -- --dry-run      # no Flagsmith calls
```

Each simulated shopper is a fresh identity (`sim-…`, trait `simulated = true`). It gets its variant from Flagsmith, which records the exposure, then sends `add_to_cart`, `checkout_started` and `checkout_completed` at the rates given. **Those rates are assumptions.** Use simulated traffic to show the pipeline works, and report it separately from real shoppers. Each shopper costs about two Flagsmith requests; the free plan allows 50,000 a month.

## Previewing a version

- **Locally** (`npm run dev:web` only): add `?ff_product_trust_signal=reviews` (or `control`) to a product page URL. Production builds ignore this, because it would show one version while Flagsmith records another.
- **On the live site, for the demo video:** in Flagsmith, add an identity override for your own visitor ID (from `/api/experiments/config`) to force a version.

## Checking it works

- `GET /api/experiments/config` should return a non-null `environmentKey` and a 16-character `identity`.
- In the browser's network tab, flags come from Flagsmith after page load, and event batches go out every 10 seconds and when the tab is hidden.
- Flagsmith skips invalid events silently. If nothing arrives, check the event names, that the identity is set, and that the warehouse is connected.
