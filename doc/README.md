# StockHop: Project Docs

> **Find it nearby. Buy with confidence.**
> Team **Rangers** (team-507B79F29773) · Dr Ambedkar Institute of Technology
> Build Bengaluru 2.0 · HackBriven × Newton School × Google · 21–22 Nov 2026

These docs are the single source of truth for the build. If code and docs disagree, fix one of them right away. Don't leave the mismatch in place.

## Source documents (read-only inputs)

| File | What it is |
|---|---|
| [`Hackathon Brief_ Build the Online Store.docx.pdf`](./Hackathon%20Brief_%20Build%20the%20Online%20Store.docx.pdf) | The problem statement (Aiven brief) |
| [`submission -Rangers.pdf`](./submission%20-Rangers.pdf) | Our 6-slide concept proposal, which is what judges already saw |

## Read in this order

| # | Doc | Read it if you are… |
|---|---|---|
| 01 | [Requirements traceability](./01-requirements-traceability.md) | Everyone. Every requirement from the brief and every promise from our slides, mapped to what we build and how we prove it |
| 02 | [Gap analysis](./02-gap-analysis.md) | Everyone. What the submission is **missing**, what's under-specified, and what we add to stand out |
| 03 | [Architecture](./03-architecture.md) | Backend / events. Components, flows, consistency model, failure modes, decisions |
| 04 | [Data model & events](./04-data-model-and-events.md) | Backend / search. PostgreSQL DDL, OpenSearch mapping + queries, Kafka topics + event schemas, seed catalogue |
| 05 | [API spec](./05-api-spec.md) | Frontend + backend. Every endpoint, request/response, error codes |
| 06 | [Frontend design](./06-frontend-design.md) | Frontend. Screens, states, design tokens matching our deck |
| 07 | [Build plan](./07-build-plan.md) | Everyone. Timeline, roles, checkpoints, git workflow, definition of done |
| 10 | [Aiven setup](./10-aiven-setup.md) | Whoever provisions services. Step-by-step + gotchas |
| 11 | [Razorpay test](./11-razorpay-test.md) | Payments. Test Mode gateway harness: what it proves, what it does not, and how to run it |
| 12 | [Concurrency & pipeline metrics](./12-metrics.md) | Everyone before the demo. Measured race, outbox, Kafka→OpenSearch and payment results, plus open findings |
| 13 | [Payments and the two-laptop demo](./13-payments-and-demo.md) | Payments + demo. Razorpay Test checkout with stock holds, partner retailers, demo steps |
| 14 | [Shopper analytics](./14-analytics.md) | Ops + pitch. Clickstream through the outbox, Kafka and OpenSearch, charted on /ops |
| 15 | [Load test on the live deployment](./15-load-test.md) | Everyone. Live-stock polling (Valkey), search (OpenSearch) and a checkout stampede (PostgreSQL) against the public Aiven URL, with causes and next steps |
| 16 | [Customers dashboard on ClickHouse, coupons, prices across cities](./16-customers-clickhouse.md) | Retailer. Who buys and browses most (Aiven for ClickHouse fed from Kafka), personal coupons that open a product in the customer's city, partner prices in every city |
| 18 | [Retailer accounts and demo logins](./18-retailer-accounts.md) | Each partner shop signs in and sees only its own dashboard (sales, regulars, last units, live viewers); coupons for its regulars that work only for that customer at that shop; demo retailer and shopper logins |

## The one-paragraph version

A city-aware storefront for a retail chain going online. **PostgreSQL** is the truth: stock is allocated once, atomically, under a row lock, so the last unit can never be sold twice. The order, the stock change and an **outbox** event commit in one transaction. A relay publishes outbox rows to **Kafka**. Independent consumer groups react: one keeps the **OpenSearch** index in sync (version-guarded, so replays and duplicates are harmless), one sends order confirmations and low-stock alerts, and one pushes live stock changes to open browsers. Search is typo-tolerant and filters by city, category and price. We prove it live: two shoppers and one unit, a 50-vs-5 stampede, killing the indexer mid-demo, and replaying history.
