# Setup

## What you need

- Node.js 20 or newer
- These Aiven services: **PostgreSQL**, **Apache Kafka**, **OpenSearch**, **Valkey** and **ClickHouse**
- **Flagsmith**: a Production and a Simulation environment, each with a warehouse connected, and the Flagsmith CLI v2 ([flagsmith.md](flagsmith.md#setting-it-up))

## Run it locally

```bash
npm install
cp .env.example .env     # fill in the service URLs and FLAGSMITH_ENVIRONMENT_KEY
                         # put the Aiven CA certificate in ./certs (git-ignored)
npm run smoke            # checks PostgreSQL, Kafka and OpenSearch connectivity
npm run kafka:topics     # creates the Kafka topics
npm run demo:reset       # migrates, creates the search index, seeds the catalogue
npm run reviews:seed     # demo reviews for the reviews version of the experiment
npm run dev:app          # API + storefront on http://localhost:5173
```

On an existing database, `npm run db:migrate` adds the reviews table without touching anything else. `reviews:seed` replaces only the generated reviews, never ones shoppers wrote.

`npm run dev` also starts the background workers. Don't run workers locally while the deployed workers are running: they share the same Kafka consumer groups and database connections.

Every variable is listed with a comment in [`.env.example`](../.env.example). Never commit `.env` or anything in `certs/`.

## Deploy

[`compose.yaml`](../compose.yaml) describes the two apps for Aiven App Runtime:

| App | Dockerfile | Runs |
|---|---|---|
| `web` | `Dockerfile` | Storefront and API on port 8080 |
| `workers` | `Dockerfile.worker` | Outbox relay, search indexer, notifier, analytics |

Connect the Aiven services to both apps in the console, and set `FLAGSMITH_ENVIRONMENT_KEY` on `web`. Redeploy after pushing to `main`.

## Checks

```bash
npm test                 # unit tests
npm run typecheck
npm run test:concurrency # stock races, deadlocks, idempotency (writes doc/concurrency-results.md)
npm run load:test        # load test against a running deployment
npm run traffic:sim -- --dry-run   # simulated shoppers for the experiment (doc/flagsmith.md)
npm run exp -- check --env=prod    # Flagsmith: warehouse, flag, keyed variation, metrics, experiment
```
