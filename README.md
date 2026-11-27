<div align="center">

# StockHop × Flagsmith

### Do reviews make shoppers add to cart?

An A/B test on a real online store, run with **Flagsmith feature flags** and **Flagsmith Experimentation**.

Team **Dark Launchers** · Toggle Wars: The Flagsmith Experimentation Hackathon (WeMakeDevs) · 26–29 Nov 2026 · Track 01, Test Something Real · Track 04, Agent Skills

**[Live store](#) · [Demo video](#) · [Agent Skill](skills/flagsmith-experiment) · [Results](#results)**

</div>

---

## The experiment

StockHop is a city-aware online store: every product shows how many are on the shelf in your city, live, and the last unit can never be sold twice. Its product page shows price, stock and partner shop offers, but nothing about what other shoppers think.

Big marketplaces lead with reviews. Do they earn their place on a local store's product page? We test it.

| | |
|---|---|
| **Hypothesis** | Showing reviews on the product page raises the share of shoppers who add to cart by at least 10% |
| **Flag** | `product_trust_signal`, multivariate, split 50 / 50 |
| **Versions** | **control** (today's page) · **reviews** (stars, count and a recent review under the price, plus a full reviews section where shoppers can write their own) |
| **Primary metric** | `add_to_cart`, per shopper |
| **Secondary and guardrail** | `checkout_started`, `checkout_completed` and order revenue |
| **Decision rule** | Ship reviews at ≥ 95% win probability with no revenue loss; otherwise keep control |
| **Traffic** | Real shoppers on the live store. Simulated shoppers (`npm run traffic:sim`) run in a **separate Flagsmith environment** so they can't mix into the real result |

We also designed a third version, "N bought in your city this week". We measured it before launch: it would have shown on only about 20% of products, so we cut it rather than run a diluted test. Full plan, what we cut and why, limitations and results: [doc/experiment.md](doc/experiment.md)

## Results

Data freeze Sun 29 Nov, 12:00 IST. Real and simulated shoppers are separate Flagsmith environments and are never added together.

| Traffic | Version | Exposed | Add-to-cart rate | Lift | Win probability |
|---|---|---|---|---|---|
| Real shoppers | control | _ | _ | — | — |
| Real shoppers | reviews | _ | _ | _ | _ |
| Simulated (rates are inputs) | control | 2,007 | 10.8% | — | — |
| Simulated (rates are inputs) | reviews | 2,043 | 13.1% | +21.9% (95% CI +1.4% to +42.4%) | 98.2% |

**Decision (real shoppers):** _to be filled in at the freeze, by the rule above._ **Simulated run (27 Nov, 4,050 shoppers):** the simulator was told reviews convert at 13% vs 10%. Flagsmith found it, with a 98.2% chance to beat control on add-to-cart and revenue +58% (98.0%), so the rule reads "ship reviews". That shows the pipeline works end to end. It is not evidence about real shoppers ([snapshot](doc/results.md)). A 10% lift needs about 15,000 shoppers per version, and a few days of real traffic gives far fewer, so "inconclusive, keep control" is the likely and honest outcome. The simulated run shows the whole pipeline, and Flagsmith calling a lift we set. Details and sample-size maths: [doc/experiment.md](doc/experiment.md#result).

## How we use Flagsmith

```mermaid
flowchart LR
    S[StockHop server] -->|environment key +<br/>hashed visitor ID| B([Shopper browser])
    B -->|identify, fetch flags| F[[Flagsmith]]
    F -->|variant for this visitor| B
    B -->|exposure + add_to_cart,<br/>checkout events| F
    F --> R[Experiment results<br/>lift · win probability]
    R -->|roll out the winner<br/>with the same flag| F
```

- **One identity for flags and events.** The server gives each browser a one-way hash of its session, which Flagsmith uses as the identity. A shopper keeps their variant for the whole visit, even if they sign in.
- **Exposure is recorded where the change is seen.** `useVariant()` is called only in the component that renders the difference.
- **Conversions come from real store events:** add to cart from anywhere, placing an order, a confirmed order (with its total), and back-in-stock alerts.
- **Real and simulated traffic never mix.** Simulated shoppers have their own Flagsmith environment with a copy of the flag and experiment, and the simulator refuses the live store's key.
- **Set up and read from one command.** `npm run exp -- check | setup | start | results` sends the Admin API requests from Flagsmith's coding-agent guide for either environment, and asks before starting. The metric list lives in one file, and a test fails if it drifts from the events the store sends.
- **The winner ships with the same flag.** No redeploy is needed.
- **Fails safe.** With no key set, or if Flagsmith is unreachable, everyone sees control and the store works as before.

Setup, code map, flags and events: [doc/flagsmith.md](doc/flagsmith.md)

## Run it

```bash
npm install
cp .env.example .env     # Aiven service URLs + FLAGSMITH_ENVIRONMENT_KEY
npm run demo:reset       # database, search index and catalogue
npm run reviews:seed     # demo reviews
npm run dev:app          # http://localhost:5173

# Flagsmith (after creating the flag with the Flagsmith CLI, doc/flagsmith.md)
npm run exp -- setup --env=prod && npm run exp -- start --env=prod
npm run exp -- results --env=prod
```

Preview the reviews version locally with `?ff_product_trust_signal=reviews` on any product page.

Requirements, deployment and checks: [doc/setup.md](doc/setup.md)

## Track 04: the `flagsmith-experiment` Agent Skill

[`skills/flagsmith-experiment`](skills/flagsmith-experiment) is an [Agent Skill](https://agentskills.io/specification) that takes a coding agent through the job we did by hand, using only the **Flagsmith CLI**: pre-flight (CLI version, warehouse), the brief and a decision rule, an approved plan, a flag with keyed variants, metrics, the experiment, SDK exposure and conversion code, start, results, the decision, and rollout with the same flag.

- **Safe around production:** nothing changes without an approved plan. Create, start and end each ask again, and in an environment named prod/live the user must type its name. It never touches a running experiment's flag.
- **Token-efficient:** `SKILL.md` is about 1.7k tokens. Request bodies, SDK snippets and troubleshooting load only at the step that needs them, and every CLI call uses `--jq`.
- **Checked:** `npm test` validates it against the Agent Skills spec.

Install and demo run: [skills/flagsmith-experiment/README.md](skills/flagsmith-experiment/README.md)

## Built with

- **Flagsmith**: feature flags and Experimentation (`@flagsmith/flagsmith` 12.4.0), the Admin API and the Flagsmith CLI v2
- **Aiven**: PostgreSQL, Apache Kafka, OpenSearch, Valkey, ClickHouse and App Runtime
- **App**: TypeScript, Express, React, Vite

How the pieces fit together: [doc/architecture.md](doc/architecture.md)

## Team Dark Launchers

Somya (lead) · Pradhyumna Kudtherkar · Zaiba Firdous · Abhishek M Shivanagoudar

## Credits

- StockHop was first built for Build Bengaluru 2.0 (21–22 Nov 2026), [original repository](https://github.com/abhishiv17/Stockhop). Everything after the `stockhop-base` tag was built for this hackathon.
- Libraries: express, pg, kafkajs, @opensearch-project/opensearch, ioredis, zod, react, react-router-dom, @huggingface/transformers, lenis, GSAP (GreenSock Standard No-Charge licence), @flagsmith/flagsmith.
- Embedding model: `Xenova/all-MiniLM-L6-v2` (Apache-2.0).
- Product photos: Unsplash and Pexels, each photographer credited in [`web/src/productPhotos.ts`](web/src/productPhotos.ts). Cut-out images: Wikimedia Commons, by Vijay Verma (CC0), Trent Huss (CC BY-SA 4.0), PantheraLeo1359531 (CC BY-SA 4.0) and SeriouslyBored (CC0).
- Fonts: Outfit, Anton, Caveat and JetBrains Mono (Google Fonts, OFL).
- Product names, brands, partner shops and the starting reviews in the demo catalogue are fictional. Reviews written on the site are stored separately.
- AI coding assistants were used, as allowed by the hackathon rules.

## Security

Credentials come from environment variables only. `.env` and `certs/` are git-ignored; [`.env.example`](.env.example) lists the variable names.
