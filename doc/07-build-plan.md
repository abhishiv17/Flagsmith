# 07: Build Plan

**Window:** Sat 21 Nov 10:00 → Sun 22 Nov 10:00 (24 h). Submission must land **before 09:30** (keep 30 min buffer).
**Meals provided:** Day 1 dinner, Day 2 breakfast. Everything else is on us. Bring snacks.

## 0. Where we are (updated Sat 21 Nov, 16:10 IST)

**Phase:** Happy path (15:00–19:30). **Next gate: CP3 at 19:30.** The backend is ahead of plan: much of the 20:30–01:00 "Differentiators" block is already done and measured in [12](./12-metrics.md). What's left is verifying the flows **in a browser**, rehearsing the drills, and deciding Q8 (Razorpay).

| Checkpoint | Status | Evidence |
|---|---|---|
| CP1 smoke | ✅ | `npm run smoke`: PostgreSQL, OpenSearch, Kafka round trip all green |
| CP2 checkout → outbox → index | ✅ | [12](./12-metrics.md) C1/P1: every order writes its events; 60/60 burst changes indexed; index 90/90 in sync |
| CP3 browser flow | ✅ Passed in a browser on the live site (16:17) | "bluetoth earphones" → Everyday Buds first (38 ms) → add → reload keeps cart → checkout → order SH-BLR-161 shows "Confirmation sent ✓". Stock restored to 1 afterwards |
| CP4 two-window demo | 🟡 Backend proven; rehearsal pending | Live Vercel race: 30 shoppers / 5 units → 5 orders, 25 clean 409s, 0 errors ([12](./12-metrics.md) D1). Live-stock card UI exists |
| Proof drills | 🟡 Partial | Stampede ✅ (`checkout:race`, `test:concurrency`). Duplicate and stale replay ✅ ([12](./12-metrics.md) O1). `drill:outage` and `drill:replay` written; not yet run, because a second laptop on the venue network is also running an indexer. Only the demo laptop may run workers |

**Done ahead of schedule:** idempotent checkout (incl. concurrent duplicates), deadlock-safe ordering, restock endpoint, `/api/stock`, Vercel deploy + env vars, `/ops` page, connection-limit hardening (503 BUSY + retry), concurrency metrics.

**Deployed on Aiven App Runtime (18:00):** `web` and `workers` from `compose.yaml`, AWS eu-central-1 (Frankfurt; Runtime offers Europe and North America only), wired to the existing PostgreSQL, OpenSearch and Kafka through Runtime integrations. Live: health, search, all four workers and outbox → Kafka → index verified on the public URL. Redeploys are manual ("Deploy latest commit"); pushes to `main` don't redeploy Runtime. Workers run **only** in the cloud now: laptops must not run `npm run workers`. Next steps for the platform are in §8.

**After round 1 (20:00): judges asked about market impact and "where do you show accurate data", not architecture.** We changed the product so it answers on screen:
- Every stock count now shows "● Live · checked N s ago" (the stock version is in the tooltip). The product page's city table says "From our database · checked N s ago".
- `/ops` is now the retailer's **Store console**. **Missed demand** comes first: shoppers turned away (by reason), sent to another city or partner, bought anyway; a restock list per product × city; searches with no results. The pipeline tiles sit below under "Stock accuracy, behind the scenes".
- `npm run e2e` now races the last unit at **add to cart**, where cart claims decide it. The live site passes 15/15.

**Co-located (19:15):** after the live load test ([15](./15-load-test.md)) showed checkout limited by the Frankfurt ↔ Singapore distance, **PostgreSQL and OpenSearch were migrated from DigitalOcean Singapore to DigitalOcean Frankfurt**. Aiven moved the running services; hostnames, credentials and prices are unchanged. The apps, PostgreSQL, OpenSearch and Valkey now sit in the same city. Kafka stays in Bengaluru: it is off the shopper's request path (outbox → relay is asynchronous). Laptops in India now see ~150 ms more to the database. The deployed site is the one that matters. **Result on the live site:** the 40-shopper / 5-unit checkout stampede went from 16 × `503` and a 22 s p50 to **0 × `503` and a 0.53 s p50**, still exactly 5 orders ([15](./15-load-test.md#after-moving-the-databases-next-to-the-app)).

**Built outside the original plan:** Razorpay Test Mode harness ([11](./11-razorpay-test.md)), the concurrency suite ([12](./12-metrics.md)), Docker files (`compose.yaml`, `Dockerfile.worker`).

**Definition of done (§6) right now:** ✅ demo values match slide 3 (Everyday Buds ₹1,299 · 1 left, Pocket Speaker ₹999 · 6, Travel Bottle ₹699 · 8) · ✅ stampede exact, no 500s · ✅ double-submit → one order · ✅ no secrets in `git log -p` · ✅ README run instructions + disclosure · ✅ outage drill on the live site (workers off → 3 orders still placed → outbox held 6 events → back in sync within 4 s of the workers returning; found and fixed a stale-cache bug, [15](./15-load-test.md#outage-drill-the-event-pipeline-switched-off-on-the-live-site)) · ⬜ offset-reset replay drill · ⬜ every 01 row checked in a browser · ✅ reload on every page (10 routes loaded fresh by URL, live site, 21 Nov 20:50) · ✅ phone-width pass (390 px: no page scrolls sideways; product page and Store console checked by eye).

### Razorpay (payments): where it stands

- **Built (Test Mode only):** admin-token routes `POST /api/payments/test/orders`, `GET /api/payments/test/orders/:orderId` and `GET …/:orderId/payments`, a localhost-only Checkout page `/razorpay-test.html`, and `npm run payment:test`. See [11](./11-razorpay-test.md).
- **Verified:** 20 concurrent gateway orders, all unique and unpaid ([12](./12-metrics.md) PAY1). The recorded 5-tab experiment order ended paid exactly once (₹1 simulated) after 6 attempts: 5 deliberately declined, 1 captured.
- **Not built:** payment is **not part of StockHop checkout**. Checkout still confirms the order and allocates stock immediately. There is no pending-payment/reservation state, no signature verification and no webhooks. [02](./02-gap-analysis.md) still lists payments as out of scope.
- **Decision needed:** Q8 below.

## 1. Principles

1. **Happy path first, bulletproof, then proof drills, then polish.** A working boring demo beats a broken ambitious one.
2. **End-to-end skeleton by CP2.** Ugly but connected beats pretty but disconnected.
3. **Feature freeze at 04:00.** After that: bugs, rehearsal, deck only.
4. Anything not in [01](./01-requirements-traceability.md) or the 🔴/🟠 rows of [02](./02-gap-analysis.md) needs a team yes before anyone builds it.
5. Commit at least hourly (timestamps prove in-window work, rule 7).

## 2. Roles (TEAM: fill names; if 3 people, merge D into B and C)

| Role | Owns | Key files |
|---|---|---|
| **A: Core backend** | PG schema, migrations, seed, `changeStock`, cart + checkout + orders API, idempotency | `server/domain/*`, `server/routes/cart.ts`, `checkout.ts`, `server/db/migrations` |
| **B: Events & ops** | Aiven setup, Kafka client, relay, indexer, notifier, monitor, `/ops/summary`, drills, Vercel deploy | `server/workers/*`, `server/lib/kafka.ts`, `server/routes/ops.ts`, `scripts/stampede.ts`, `replay.ts` |
| **C: Frontend** | All React screens, design tokens, live card behaviour, `/ops` UI | `web/` |
| **D: Search, data & pitch** | OpenSearch index + queries, synonyms, search + stock routes, seed catalogue + SVG images, Qwen research + deck, demo script, backup video | `server/lib/search.ts`, `server/routes/search.ts`, `stock.ts`, `scripts/reindex.ts`, `doc/08` |

Pairing rule: A and B review each other's transaction and consumer code. That's where the correctness claims live.

## 3. Timeline & checkpoints

| Clock | Phase | A: Core | B: Events | C: Frontend | D: Search/Pitch |
|---|---|---|---|---|---|
| **10:00–11:30** | Setup | Repo scaffold, npm workspaces, config loader | **Provision Aiven PG/Kafka/OS**, download certs, create topics, share `.env` privately | Vite app, tokens, routing shell, header + city picker | Install Antigravity check (all), Qwen research on problem; finalize seed data |
| **CP1 11:30** | ✅ `npm run smoke` green on **every** laptop (PG query, Kafka produce+consume, OS ping) | | | | |
| 11:30–15:00 | Skeleton | Migration, `changeStock`, seed (via outbox), checkout txn | Relay, indexer (external version), monitor + heartbeats | Home grid + search page against **mock JSON** matching [05](./05-api-spec.md) | Index + alias, query DSL tested in Dashboards, `/search` route |
| **CP2 15:00** | ✅ `curl POST /checkout` → order in PG → outbox published → index doc `qty` + version updated. Seed built the index through Kafka | | | | |
| 15:00–19:30 | Happy path | Cart API, orders API, error codes | Notifier + `notifications`/`stock_alerts`, `/ops/summary` (lag, drift) | Wire real API: search, product page, cart, checkout, order page | Facets, "nearby" query, `tookMs`; SVG illustrations |
| **CP3 19:30** | ✅ In a browser: search "bluetoth earphones" → add → reload (cart kept) → checkout → order page shows "Confirmation sent ✓" | | | | |
| 19:30–20:30 | 🍛 Dinner (provided) + **first full demo run**, write down every rough edge | | | | |
| 20:30–01:00 | Differentiators | Idempotency, deadlock-safe ordering, restock endpoint | `/api/stock` live endpoint, Vercel deploy + env vars, `stampede.ts` | Live card flip, `/ops` page, 409 UX | Deck v1 in **Qwen** (AI Slides), pitch script draft |
| **CP4 01:00** | ✅ Two-window demo works: A buys last unit → B's card flips within ~1s → B's checkout gets 409 | | | | |
| 01:00–04:00 | Proof drills | Fix bugs from drills | `replay.js`, kill/restart drill, verify drift → 0 | Ops polish (lag sparkline, coral states), mobile pass | Rehearse narration on drills |
| **04:00** | 🧊 **FEATURE FREEZE** | | | | |
| 04:00–07:00 | Harden + rest | Sleep in **2 shifts** (A+C sleep 04:00–05:30, B+D 05:30–07:00). Awake pair: bug bash with the checklist in §6 | | | |
| 07:00–08:30 | Deck + rehearsal | 🍳 Breakfast (provided). Deck final in Qwen. **Rehearse full demo 3×**, timed. **Record backup demo video** | | | |
| 08:30–09:30 | Submit | Final README, disclosure, tag `v1.0`, submit on the official platform, verify the submission went through | | | |
| 09:30–10:00 | Buffer | Nothing new. Services up? `npm run smoke` once more | | | |

**If behind schedule:** at CP2 + 2h with no end-to-end, drop `notifier` low-stock alerts, the "nearby" hint and the sparkline. Keep these always: checkout txn, outbox, relay, indexer, search, cart, two-window demo, `/ops` basic tiles, notifier confirmation (that one is required by the brief).

## 4. Git workflow

- `main` always runs. Short-lived branches `a/checkout`, `b/relay`, `c/cart-page`… merged by PR or `git pull --rebase` + push, at least hourly.
- Commit style: `feat(checkout): conditional stock decrement`, `fix(indexer): treat 409 as success`, `docs: …`.
- **Before every commit:** `git status` and check that **no `.env`, `certs/`, `*.pem`, `*.key`, `*.cert`** appear. `.gitignore` covers them, but check anyway. If a secret is ever pushed: **rotate it in Aiven immediately**, since deleting the commit isn't enough.
- Don't commit `node_modules`, build output or recordings > 50 MB.
- Tag `v1.0` at submission.

## 5. npm scripts (root)

| Script | Does |
|---|---|
| `npm run smoke` | Checks PG, Kafka (produce+consume to a test key), OpenSearch; prints ✅/❌ |
| `npm run db:migrate` | Applies `001_init.sql` (idempotent) |
| `npm run db:seed` | Truncates + seeds 30×3 via `changeStock` (outbox) |
| `npm run search:init` | Creates `products_v1` + alias (if missing) |
| `npm run search:reindex` | Rebuilds index from PG (version-guarded) |
| `npm run dev` | Runs api + relay + indexer + notifier + web concurrently (prefixed logs) |
| `npm run dev:api` / `relay` / `indexer` / `notifier` / `web` | Individually (for kill/restart drills) |
| `npm run demo:reset` | migrate → seed → wait for drift 0 |
| `npm run drill:stampede -- WRB-002 BLR 5 50` | 50 concurrent checkouts on 5 units; prints counts + p50/p95 + verifies PG qty = 0, orders = 5 |
| `npm run drill:replay` | Stops nothing itself; resets `search-indexer` offsets to earliest (indexer must be stopped first), prints instructions |

**Actual scripts as of 16:10** (the plan above is the original intent):

| Script | Status / does |
|---|---|
| `npm run workers` · `workers:indexer` · `workers:core` | ✅ All workers, or just the indexer / relay+notifier+monitor (use for the kill-indexer drill). Run workers **without** `watch` during the demo |
| `npm run checkout:race` | ✅ 5 shoppers / 1 unit race (Afreen) |
| `npm run test:concurrency` | ✅ Full concurrency + pipeline suite; rewrites [12](./12-metrics.md). Covers what `drill:stampede` was meant to do, and more |
| `npm run e2e` | ✅ Two-shopper end-to-end against a running API (CP3/CP4 proof) |
| `npm run payment:test` | ✅ Razorpay Test Mode gateway checks |
| `npm run check:sync` · `kafka:topics` · `demo:reset` | ✅ Index drift check · create topics · migrate + reindex + seed |
| `npm run drill:outage` · `drill:replay` | 🟡 Written (`scripts/drill.ts`): indexer outage with 3 sales + recovery timing, and full rewind to the first event with an identical-index check. Need the indexer stopped everywhere first |
| `drill:stampede`, `dev:relay` | ⬜ Not built under these names. Stampede is covered by `checkout:race`/`test:concurrency`. (`search:reindex` exists now: zero-downtime reindex, [19](./19-search-and-pitch.md)) |

## 6. Definition of done (checked at CP3/CP4 and in the bug bash)

- [ ] All [01](./01-requirements-traceability.md) rows marked ✅ were verified **in the browser**, not assumed.
- [ ] `demo:reset` → slide-3 values exactly (Everyday Buds ₹1,299 · 1 left, Pocket Speaker ₹999 · 6 left, Travel Bottle ₹699 · 8 left).
- [ ] Stampede: exactly N orders for N units, `inventory.qty = 0`, no 500s, no negative qty.
- [ ] Kill indexer → 3 orders succeed → lag > 0 visible → restart → lag 0, drift 0.
- [ ] Replay from earliest → index unchanged, drift 0, no errors.
- [ ] Double-click Place Order → one order.
- [ ] Reload on every page works (no state only in memory).
- [ ] App works on a phone-width window.
- [ ] No secrets in `git log -p` (`git log -p | grep -i -E "avnadmin|password|BEGIN (RSA|PRIVATE)"` returns nothing).
- [ ] README has run instructions and the AI/third-party disclosure.

## 7. Open decisions (answer in the first hour)

| # | Question | Default if no answer |
|---|---|---|
| Q1 | Team size + names per role | 4 roles; merge D if 3 people. **Still open** |
| Q2 | JS or TypeScript | ✅ **TypeScript** (ADR-7) |
| Q3 | Demo from a laptop only, or also deploy? | ✅ **Aiven App Runtime** (Frankfurt) for web + API **and** workers, from `compose.yaml`. Replaces the earlier Vercel + laptop-workers setup (ADR-11), which stays only as a fallback |
| Q4 | Kafka auth: client cert (mTLS) or SASL? | ✅ **SASL/SCRAM over TLS**. We switched from mTLS during setup; the code supports both (`KAFKA_SASL_USERNAME` set → SASL) |
| Q5 | Which laptop runs the demo? | The one with the best battery + HDMI/USB-C adapter. It also runs the workers |
| Q6 | Aiven tier | ✅ **Developer**, trial credits (ADR-12) |
| Q7 | Supabase? | ✅ Not used; Aiven PG only (ADR-14) |
| Q8 | Wire Razorpay into StockHop checkout before the 04:00 freeze, or demo it separately? | ✅ **Wired in** (Test Mode): pay-then-confirm with stock holds, see [13](./13-payments-and-demo.md). Payment turns on only when the Test Mode keys are set. Original note, kept for context: **Still open.** Integrating means a pending-payment/reservation state, signature verification and webhooks, all inside the checkout transaction our correctness claims rest on (see [11](./11-razorpay-test.md) "What this proves and what it does not"). Principle 4 applies: needs a team yes. Until then: demo the Test Mode gateway check separately and present integration as the next step |

## 8. More Aiven services: plan (added Sat 21 Nov, 18:10)

Lesson from the first Runtime deploy: PostgreSQL (Developer plan) has **11 usable connections**, shared by Runtime `web`, Runtime `workers`, the old Vercel deployment and any laptop running the API. On first boot the laptops held 6 of them and the live site answered 503 BUSY until they were stopped. Rule now: one process tree per laptop at most, and no local workers.

Ordered by value for effort. Anything below the line needs a team yes before the 04:00 freeze (principle 4).

| # | Aiven feature | Why for StockHop | Effort | Status |
|---|---|---|---|---|
| S1 | **PostgreSQL connection pool (PgBouncer)**: a feature of the existing service, not a new one | Many app connections share a few database slots, which removes the "slots full" failure above. `web` connects through the pool (transaction mode); `workers` keep a direct connection because the relay's `pg_try_advisory_lock` is session-level and migrations need a session | ~1 h: create the pool in the console, give `web` the pool URL, retest `test:concurrency` | ✗ Blocked: the Developer PostgreSQL plan has no connection pooling (needs Startup). Co-locating PostgreSQL with the apps is the bigger win anyway ([15](./15-load-test.md) next steps) |
| S2 | **Event contracts checked at runtime** (no new service) | Today consumers do `JSON.parse(…) as Envelope<InventoryChanged>`: a TypeScript cast, not a check. A renamed field (e.g. `qty`) would be written into OpenSearch as `undefined`, stay in Kafka and come back on every replay. Fix: zod schemas next to `server/lib/events.ts`, validated in the relay **before publishing** (bad event stays `pending` in the outbox, visible on `/ops`) and in each consumer **after reading** (logged and skipped). Changes are additive only; `schemaVersion` bumps on anything else | ~1 h | ⬜ Next |
| S3 | **Aiven for Grafana** + metrics integration | Ready-made dashboards for Kafka lag, PG connections and OpenSearch latency, connected in the console with no code. Shown beside `/ops` during the stampede drill | ~30 min, console only | ⬜ |
| S4 | **OpenSearch Dashboards** (already included) | Show the `products` index and the typo-tolerant query live; no cost | 15 min | ✅ `npm run dashboards:setup`: dashboard "StockHop · live stock and demand" (catalogue at a glance, units and sold out by city, stock by category × city, good-for occasions, orders over time, what shoppers search, sold-out seen by city; refreshes every 10 s) + saved searches "Sold out right now", "Last units", typo search "bluetoth earphones" ([19](./19-search-and-pitch.md#opensearch-dashboards)) |
| — | — | *Needs a team yes* | — | — |
| S5 | **Aiven for Valkey** (Redis-compatible cache) `stockhop-valkey`, Developer-4, Europe | Live stock is polled every 1.5 s per open browser; each poll was an OpenSearch mget **plus** a second search for the nearest city with stock. Now: one pipelined Valkey read returns every city for the visible products. Indexer writes through after OpenSearch accepts a batch; the API reads through from OpenSearch on a miss; a Lua script only accepts newer versions; keys expire after 5 min. Valkey down or unset → OpenSearch, as before (`server/lib/cache.ts`). `/api/stock` reports `X-Stock-Source` and `Server-Timing` | done | ✅ Live: 1.4 ms p50 under load ([15](./15-load-test.md) L1) |
| S6 | **Schema Registry (Karapace)**: a setting on the Kafka service | The production version of S2: each topic has a registered schema and a compatibility rule, so a breaking change is refused at publish time, every message carries its schema id (safe replays, gradual rollouts) and the contract lives in one place for every consumer. Needs Avro/JSON Schema serialisation and handling of the JSON messages already in the topics; plan availability on Developer Kafka unconfirmed | ~half a day | ⬜ After the event, unless S2 is done early |
| S7 | **Aiven for ClickHouse** | Read `orders.placed` / `inventory.changed` / `user.activity` straight from Kafka for a "where demand is" view (sell-outs by city and hour) | New service + schema + UI | ✅ Built by the team: Customers dashboard on Aiven for ClickHouse ([16](./16-customers-clickhouse.md)) |
| S8 | **Kafka Connect + Debezium (CDC)** | Could replace the hand-written outbox relay. Not planned: the relay with its advisory-lock standby is part of our design, and Connect likely needs a bigger Kafka plan | — | ✗ Skip |

Not available: PostgreSQL read replicas (not offered on the Developer plan). Not yet evaluated: the console's "AI gateway" and "Agents".

**Before the next Runtime redeploy:** the shopper-analytics commits publish to a new topic, `user.activity`. Create it first (`npm run kafka:topics`), then "Deploy latest commit" on **both** `web` and `workers`.

## 9. Shopper accounts (added Sat 21 Nov, night)

Optional sign-in, so it can't get in the way of the demo: guests still browse, race and pay. Full write-up in [17](./17-accounts.md).

| # | Step | Status |
|---|---|---|
| A1 | Passwordless email codes; an account is a `customers` row with a verified email; sessions in PostgreSQL (migration 006, applied) | ✅ |
| A2 | Guest cart and pending payment move to the account on sign-in; same cart on every device | ✅ |
| A3 | One claim per account on last units (second device → `already_yours`) | ✅ `accounts:test` |
| A4 | `/account` with your orders; header Sign in / initial; checkout pre-fills and locks the verified email | ✅ checked in Chrome |
| A5 | Loyalty coupons need sign-in with the coupon's email (`COUPON_REQUIRES_SIGN_IN`) | ✅ |
| A6 | Analytics: signed-in journeys are one visitor across devices (hashed account key) | ✅ |
| A7 | Real email delivery for codes (today: shown on screen, labelled demo, like order confirmations) | ⬜ needs a provider + key |
| A8 | "Notify me when it's back" per city: notifier marks alerts from `inventory.changed`, catch-up on read, header dot, `/account` list (migration 007, applied) | ✅ 2.1 s restock → alert through Kafka; checked in Chrome |

**Before the next Runtime redeploy:** migrations 006 and 007 are already applied to the shared database. Redeploy **both** `web` (routes) and `workers` (the notifier handles back-in-stock alerts).
