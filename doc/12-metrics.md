# 12: Concurrency & Pipeline Metrics

> **Generated file.** Re-run with `npm run test:concurrency` and this page is rewritten with fresh numbers. Source: [`scripts/concurrency-suite.ts`](../scripts/concurrency-suite.ts).

**Last run:** 21 Nov 2026, 4:00 pm IST · commit `e5b10d8` · 128363 ms total · **9/9 scenarios passed**, 39/39 checks.

## Summary

| # | Scenario | Area | Result | Headline |
|---|---|---|---|---|
| C1 | Last-units race: 50 shoppers, 5 units (×3 rounds) | Concurrent ordering | ✅ pass | 15/150 succeeded, 0 oversold · p95 7764 ms |
| C2 | Multi-item carts in opposite order (deadlock + all-or-nothing) | Concurrent ordering | ✅ pass | 6/20 succeeded, 0 deadlocks, 0 partial writes |
| C3 | Idempotency storm: 10 identical submits at once | Concurrent ordering | ✅ pass | 10 submits → 1 order, stock −1 |
| C4 | Throughput: one hot row vs five rows (25 buyers each) | Concurrent ordering | ✅ pass | hot 6.1 orders/s vs spread 6.3 orders/s |
| P1 | Burst: 60 concurrent stock changes → Kafka → OpenSearch | PostgreSQL + Outbox + OpenSearch | ✅ pass | 60/60 indexed · commit→searchable p50 1782 ms, p95 3308 ms |
| O1 | Outbox replay: duplicate and stale Kafka deliveries | Outbox + consumer idempotency | ✅ pass | 9 duplicates → 0 side effects |
| O2 | Order events end to end + PostgreSQL guard rails | Outbox + PostgreSQL | ✅ pass | 72/72 confirmations · order→notified p95 1127 ms |
| PAY1 | Payments: Razorpay Test Mode gateway under concurrency | Payments | ✅ pass | 20/20 gateway orders, unique, unpaid · p95 379 ms |
| D1 | Deployed race on Vercel: 30 shoppers, 5 units | Concurrent ordering (production) | ✅ pass | 5/30 succeeded on Vercel · p95 2996 ms |

<!-- analysis:start -->
## Findings & analysis

_Hand-written; kept across re-runs. Run `057a7675` (commit `3e16886`) found the problems below. Causes were verified with Vercel logs, a targeted repro and a database check. The fixes went out in commits `5c526c1`, `5f74892` and `9b7ec75`, and run `ff0ad955` (commit `e5b10d8`) re-tested them. **All four findings are resolved.** F5 (Valkey) was added on 21 Nov, ~7 pm, from the live-deployment A/B in [15](./15-load-test.md)._

### Before → after

| Metric | Before (`057a7675`) | After (`ff0ad955`) |
|---|---|---|
| Scenarios passing | 7/9 | **9/9** |
| D1: live Vercel race, 30 shoppers / 5 units | 💥 500s at add-to-cart (no free connections) | ✅ 5 × 201, 25 × 409, **0 × 5xx**; 10 requests rode out a `503 BUSY` via retry |
| C3: 10 identical submits | ❌ 1 × 201 + 9 × 409 `CART_EMPTY` | ✅ 1 × 201 + 9 × 200, same order |
| C4: hot-row throughput (one product, 25 buyers) | 1.6 orders/s | **6.1 orders/s** (3.8×) |
| C4: spread throughput (five products) | 3.1 orders/s | **6.3 orders/s** |
| C1: checkout p95 (50-shopper bursts) | 11 084 ms | 7 764 ms |
| C2: multi-item checkout p95 | 12 633 ms | 4 068 ms |
| P1: relay lag p50 / p95 | 437 / 781 ms | **176 / 341 ms** |
| P1: commit → searchable p50 / p95 | 4 173 / 7 195 ms | **1 782 / 3 308 ms** |
| P1: index converged after the last commit | not measured | 420 ms |
| O2: order → confirmation stored p95 | 3 149 ms | 1 127 ms |

Local latencies still include ~50–65 ms of India→Singapore round trip per SQL statement (see Environment), so treat them as an upper bound.

### ✅ F1: Production ran out of PostgreSQL connections (D1). Fixed.

- **Was:** Aiven free PostgreSQL has 15 connections, 12 usable. Each Vercel instance opened up to 5 (`PG_POOL_MAX=5`), and paused instances kept their sockets open. Ordinary traffic already hit `remaining connection slots are reserved…` at 09:53, and D1 failed with 500s.
- **Fix (`5c526c1` + Vercel env):**
  - Vercel production `PG_POOL_MAX=1`. Idle connections close after 5 s (`PG_IDLE_TIMEOUT_MS`), and pool waits time out after 10 s (`PG_CONNECT_TIMEOUT_MS`).
  - `attachDatabasePool` (from `@vercel/functions@3.10.5`) closes idle connections before Vercel pauses an instance.
  - "Slots full" connection errors are retried in `server/lib/db.ts` (3 tries, ~150/300/600 ms).
  - What's left becomes `503 BUSY` + `Retry-After`, which `web/src/api.ts` retries twice. Safe, because nothing reached the database.
- **Result:** D1 passed with zero 5xx. The database still peaked at **13 client connections** and **10 requests needed a BUSY retry**, so the fix absorbs pressure rather than removing it.
- **Still true:** capacity is tight on the free plan. On demo day, keep teammates' local APIs off the shared database. Consider Aiven connection pooling or a bigger plan if real traffic is expected. If a pooler is added, the relay must keep a direct connection because of its session-scoped advisory lock and `LISTEN`.

### ✅ F2: Concurrent duplicate submits showed "Your cart is empty" (C3). Fixed.

- **Was:** duplicates waiting on the cart lock found the cart already `checked_out` and threw `CART_EMPTY` before checking the idempotency key again. Money and stock were safe; only the response was wrong.
- **Fix (`5f74892`):** when no active cart is found, `checkout.ts` looks the key up again inside the transaction. Under READ COMMITTED it sees the winner's committed order and returns it as a replay (`200`).
- **Result:** C3 returned 1 × 201 + 9 × 200 with one order and stock −1. A separate 6-request repro gave the same.

### ✅ F3: Search lagged 4–7 s behind a burst (P1). Much improved.

- **Was:** the relay polled every 200 ms, and the indexer wrote events to OpenSearch one HTTP call at a time on a single partition.
- **Fix (`9b7ec75`):**
  - Writes to the outbox now `pg_notify('outbox_new')` in the same statement, and the relay `LISTEN`s on its lock connection, so it wakes on commit. A 1 s poll remains only as a safety net.
  - The indexer consumes whole Kafka batches, keeps only the newest version per document, and sends a single `_bulk` request with external versions. Both partitions run in parallel.
- **Result:** relay lag p50 437 → 176 ms. Commit → searchable p50 4.2 → 1.8 s. The index converges **420 ms after the last commit** of a 60-change burst. Most of the remaining p50 is the burst itself: 60 commits take ~3.4 s through this test's 3-connection pool.
- **Still possible:** run the workers in a Singapore-region host instead of a laptop, which removes two India↔Singapore hops per event.

### ✅ F4: Hot-row throughput was limited by how long the lock was held (C4). Fixed.

- **Was:** about 9 SQL round trips while holding the inventory row lock (update, load product, insert outbox, customer, order, each line item, OrderPlaced, close cart, commit).
- **Fix (`5f74892`):**
  - `changeStock` is now a single statement: conditional update + full `InventoryChanged` event + relay wake-up.
  - Everything after the stock check (customer, order, lines, `OrderPlaced`, close cart) is a second single statement.
  - The lock is held for one round trip per item + 1 + COMMIT. The event payloads are byte-for-byte the same shape as before; this was verified against older outbox rows.
- **Result:** hot row 1.6 → 6.1 orders/s, nearly matching spread rows (6.3), so lock contention has stopped being the bottleneck.

### ✅ F5: Live-stock polling loaded OpenSearch on every poll. Fixed with Aiven for Valkey.

- **Was:** every open product page polls `/api/stock` every 1.5 s. Each poll was an OpenSearch `mget` (one document per card) plus a second OpenSearch `search` for "nearest city with stock" whenever an item was sold out. From the Frankfurt app to OpenSearch in Singapore, that is two intercontinental round trips per poll.
- **Fix (`6701a93`):** an Aiven for Valkey live-stock cache (`server/lib/cache.ts`).
  - The indexer writes through to Valkey after OpenSearch accepts a batch.
  - The API reads through from OpenSearch on a miss.
  - A Lua script only accepts newer versions, so a replayed or late event can't make stock go backwards.
  - Keys expire after 5 min, and Valkey down means the API falls back to OpenSearch.
  - One pipelined read now answers every card and every city.
- **Result:** A/B on the live Aiven deployment, the same polling load against the original path (`?cache=off`) and against Valkey. OpenSearch figures are from its own `_nodes/stats`. Full method and tables: [15](./15-load-test.md#before-vs-after-valkey-ab-on-the-live-site).

| Metric (100 shoppers polling, 20 s) | Before: OpenSearch only | After: Valkey |
|---|---|---|
| `/api/stock` server time p50 / p95 / p99 | 350 / 902 / 10,470 ms | **1.9 / 93 / 190 ms** |
| Shopper-visible p50 / p95 (from Bengaluru) | 684 / 1,976 ms | **211 / 586 ms** |
| OpenSearch search queries caused by polling | 654 | **0** |
| OpenSearch document fetches caused by polling | ~15,470 | **0** |
| OpenSearch busy time | 2,472 ms | **151 ms** (background only, −94%) |
| OpenSearch node CPU avg (max) | 18.4% (32%) | **3.4% (5%)** |
| At 200 shoppers: polls served per second | 80.9 (browsers fell behind) | **129.3** (+60%) |
| At 200 shoppers: server time p99 | 11,284 ms | **400 ms** |
| Errors | 0 | 0 |

- **Still true:** at 200 shoppers the remaining server time (~91 ms p50) is the `web` container's CPU (0.2 vCPU), not Valkey. Checkout was limited by the Frankfurt ↔ Singapore distance to PostgreSQL ([15](./15-load-test.md) L3). After PostgreSQL and OpenSearch moved to Frankfurt, the 40-shopper / 5-unit stampede on the live site went from 16 × `503` and a 22 s p50 to **0 × `503` and a 0.53 s p50**, still with exactly 5 orders ([15](./15-load-test.md#after-moving-the-databases-next-to-the-app)).

### Notes

- **Workers outage during the fix:** editing the worker files made the `tsx watch` workers on the laptop exit and not come back. For a few minutes no relay was running; the outbox simply queued, as designed. They were restarted with `npm run workers` before this run. During the demo, run the workers with `npm run workers`, not under `watch`.
- Vercel logs label requests `bom1` while `vercel.json` pins functions to `sin1`. This is probably the Mumbai edge where requests enter, but it is unverified.
<!-- analysis:end -->

## Environment

| | |
|---|---|
| API under test | In-process Express app (`server/app.ts`) on this laptop, **3-connection** PG pool; D1 hits the deployed Vercel site |
| PostgreSQL | Aiven, PostgreSQL 18.7, Singapore · `max_connections = 15` (3 reserved for superusers) |
| Laptop → PostgreSQL round trip | p50 51 · p95 559 · p99 559 · max 559 ms (n=5) |
| Kafka / OpenSearch | Aiven Kafka (Bengaluru, SASL/SCRAM) · Aiven OpenSearch (Singapore) |
| Workers | relay, indexer, notifier, monitor running on the laptop (`npm run dev`) |
| Peak PG client connections seen | 13 (shared with Vercel, workers and the local dev API) |
| New deadlocks during the run | 0 (database-wide counter, `pg_stat_database.deadlocks`) |

> **Reading the latency numbers:** the in-process API runs in India and talks to PostgreSQL in Singapore, so every SQL round trip costs the RTT above (a checkout makes ~6, of which one per item + 2 happen while holding the row lock). Local latencies are therefore a **pessimistic upper bound**; D1 (Vercel `sin1`, next to the database) is the realistic production figure.

## Results

### C1 · Last-units race: 50 shoppers, 5 units (×3 rounds) — ✅ pass

**Setup:** AUD-006 · MUM set to 5 units; 50 independent guest carts submit checkout at the same instant; repeated 3 times. In-process API, pool of 3 PG connections.

| Check | Result | Detail |
|---|---|---|
| Every round: exactly 5 × 201 and 45 × 409 OUT_OF_STOCK, stock ends at 0, 5 orders in DB | ✅ | R1: 5×201, 45×409, stock after 0, wall 7350 ms; R2: 5×201, 45×409, stock after 0, wall 8994 ms; R3: 5×201, 45×409, stock after 0, wall 7287 ms; |
| No 5xx / network errors | ✅ |  |
| Outbox: each of the 15 orders has exactly 1 OrderPlaced + 1 InventoryChanged; 0 rows from the 135 losers | ✅ | 15/15 orders correct, 0 orphan stock events |

| Metric | Value |
|---|---|
| Checkout latency (all 150 requests) | p50 4462 · p95 7764 · p99 8679 · max 8984 ms (n=150) |
| Avg wall time per 50-shopper burst | 7877 ms |
| Oversold units | 0 |
| Scenario duration · peak PG connections · 503 BUSY retries | 57122 ms · 12 · 0 |

### C2 · Multi-item carts in opposite order (deadlock + all-or-nothing) — ✅ pass

**Setup:** HOM-001 · DEL = 10 units, HOM-002 · DEL = 6 units. 20 shoppers each buy 1 of both; half add them A→B, half B→A. Only 6 complete sets exist.

| Check | Result | Detail |
|---|---|---|
| Exactly 6 orders succeed, 14 get 409 | ✅ | 6×201, 14×409 |
| No deadlocks / 5xx (items locked in product_id order) | ✅ | 0 server errors |
| All-or-nothing: HOM-001 ends at 10 − 6 = 4 (failed carts released their first item) | ✅ | HOM-001=4, HOM-002=0 |
| HOM-002 ends at 0, never negative | ✅ |  |
| Outbox: 6 orders × (1 OrderPlaced + 2 InventoryChanged), no orphan stock events | ✅ | 6/6 orders correct, 0 orphans |

| Metric | Value |
|---|---|
| Checkout latency | p50 2539 · p95 4068 · p99 4211 · max 4211 ms (n=20) |
| Wall time | 4214 ms |
| Scenario duration · peak PG connections · 503 BUSY retries | 11646 ms · 9 · 0 |

### C3 · Idempotency storm: 10 identical submits at once — ✅ pass

**Setup:** One shopper, one cart (BAG-003 · BLR × 1), the same idempotency key sent 10 times concurrently (double-click / retry storm).

| Check | Result | Detail |
|---|---|---|
| All 10 responses succeed and return the same orderId | ✅ | 9×200, 1×201; distinct orderIds=1 |
| Stock decremented exactly once | ✅ | 9 → 8 |
| Exactly one OrderPlaced event | ✅ | 1 |

| Metric | Value |
|---|---|
| Latency | p50 843 · p95 1197 · p99 1197 · max 1197 ms (n=10) |
| Scenario duration · peak PG connections · 503 BUSY retries | 1906 ms · 8 · 0 |

### C4 · Throughput: one hot row vs five rows (25 buyers each) — ✅ pass

**Setup:** Hot: 25 buyers of MOB-002 · BLR (set to 25). Spread: 25 buyers across MOB-001, MOB-004, HOM-006, BAG-005, AUD-002 in MUM (5 each, enough stock). All must succeed.

| Check | Result | Detail |
|---|---|---|
| Hot row: all 25 succeed, stock 25 → 0 | ✅ | 25×201, stock 0 |
| Spread: all 25 succeed, each row decremented by exactly 5 | ✅ | 25×201 |

| Metric | Value |
|---|---|
| Hot row: wall time / throughput | 4087 ms · 6.1 orders/s |
| Hot row: latency | p50 2382 · p95 3971 · p99 4083 · max 4083 ms (n=25) |
| Spread: wall time / throughput | 3950 ms · 6.3 orders/s |
| Spread: latency | p50 2094 · p95 3711 · p99 3947 · max 3947 ms (n=25) |
| Scenario duration · peak PG connections · 503 BUSY retries | 19592 ms · 10 · 0 |

### P1 · Burst: 60 concurrent stock changes → Kafka → OpenSearch — ✅ pass

**Setup:** 10 BLR rows × 6 changes each (−1,+1,−1,+1,−1,+1 → net 0), all 60 transactions fired at once through changeStock (the only stock-writing path). Then measure relay lag, consumer lag and time until each change is visible in OpenSearch.

| Check | Result | Detail |
|---|---|---|
| All 60 transactions committed (no lost or rejected updates) | ✅ | 60 committed, 0 failed |
| No lost updates: every row is back to its starting qty (net 0) | ✅ |  |
| Outbox wrote exactly 60 InventoryChanged rows, versions strictly increasing per key | ✅ | 60 rows, monotonic=true |
| Version advanced on every touched row | ✅ |  |
| All 60 changes became visible in OpenSearch | ✅ | 60/60 |
| OpenSearch qty + version equal PostgreSQL for all 10 rows | ✅ | 10/10 |

| Metric | Value |
|---|---|
| Time to commit all 60 transactions | 3443 ms |
| Relay lag (outbox created → published to Kafka, PG clock) | p50 176 · p95 341 · p99 358 · max 358 ms (n=60) |
| Commit → visible in OpenSearch (per change) | p50 1782 · p95 3308 · p99 3470 · max 3470 ms (n=60) |
| Index fully converged after last commit | 420 ms |
| Peak Kafka consumer lag during burst (all groups) | 4 messages |
| Scenario duration · peak PG connections · 503 BUSY retries | 7305 ms · 8 · 0 |

### O1 · Outbox replay: duplicate and stale Kafka deliveries — ✅ pass

**Setup:** Simulates "relay crashed after sending, before marking published": re-produce already-published events (same eventId) 3× each — one OrderPlaced, one low-stock InventoryChanged, and the oldest burst event for a key (stale version). Consumers must absorb them.

| Check | Result | Detail |
|---|---|---|
| Re-sent 9 duplicate messages; consumers drained them | ✅ | lag back to 0 in 618 ms |
| Notifier: still exactly 1 confirmation for the order (UNIQUE event_id) | ✅ | 1 → 1 |
| Notifier: no duplicate low-stock alerts | ✅ | 23 → 23 |
| Indexer: stale v490 rejected; doc stays at latest v541 | ✅ | OpenSearch v541 qty 25; PG v541 qty 25 |
| PostgreSQL inventory untouched by consumers | ✅ |  |

| Metric | Value |
|---|---|
| Duplicate messages produced | 9 |
| Time for consumers to drain them | 1505 ms |
| Scenario duration · peak PG connections · 503 BUSY retries | 2176 ms · 8 · 0 |

### O2 · Order events end to end + PostgreSQL guard rails — ✅ pass

**Setup:** For every order created above: OrderPlaced → Kafka → notifier → confirmation row. Plus: single-relay advisory lock, the CHECK (qty >= 0) backstop, and changeStock refusing to go negative.

| Check | Result | Detail |
|---|---|---|
| Every one of the 72 orders got exactly one confirmation | ✅ | 0 missing, 0 duplicated |
| Exactly one relay holds the single-relay lock; a second relay would stand by | ✅ | holders=1, second acquire=false |
| Direct UPDATE to qty = −1 is rejected by CHECK (qty >= 0) | ✅ | SQLSTATE 23514 |
| changeStock refuses an oversell (returns null, writes no outbox row) | ✅ |  |
| Row unchanged after both attempts | ✅ |  |

| Metric | Value |
|---|---|
| Order committed → confirmation stored (PG clock) | p50 823 · p95 1127 · p99 1224 · max 1224 ms (n=72) |
| Scenario duration · peak PG connections · 503 BUSY retries | 940 ms · 8 · 0 |

### PAY1 · Payments: Razorpay Test Mode gateway under concurrency — ✅ pass

**Setup:** 20 concurrent ₹1 gateway-order creations through POST /api/payments/test/orders, auth + validation checks, and a read-back of the recorded multi-attempt order. Test Mode only: no money moves, no StockHop order or stock change.

| Check | Result | Detail |
|---|---|---|
| Unauthenticated request rejected (401) | ✅ |  |
| Below-min, above-max and fractional amounts rejected (400) | ✅ | 400,400,400 |
| 20/20 concurrent gateway orders created | ✅ | 20×201 |
| All 20 have unique gateway IDs and unique receipts | ✅ | 20 ids, 20 receipts |
| All created unpaid (amount_paid = 0, status created) | ✅ |  |
| Read-back of a new order shows ₹1 due | ✅ | status created |
| Recorded 5-tab experiment order is paid exactly once (₹1) after 6 attempts | ✅ | status paid, 6 attempts: 5 declined on purpose (mock-bank Failure button), 1 captured |

| Metric | Value |
|---|---|
| Gateway order creation latency (incl. Razorpay API) | p50 349 · p95 379 · p99 379 · max 379 ms (n=20) |
| Wall time for 20 concurrent | 379 ms |
| Recorded order attempts | 6 attempts: 5 declined on purpose (mock-bank Failure button), 1 captured (₹1 simulated) |
| Scenario duration · peak PG connections · 503 BUSY retries | 2402 ms · 6 · 0 |

### D1 · Deployed race on Vercel: 30 shoppers, 5 units — ✅ pass

**Setup:** WRB-001 · DEL set to 5; 30 shoppers create carts and check out simultaneously against https://stockhop.vercel.app (Vercel functions in sin1, next to Aiven PG). Real serverless scaling and connection limits.

| Check | Result | Detail |
|---|---|---|
| Never oversold: ≤ 5 orders and stock ≥ 0 | ✅ | 5 orders, stock 0 |
| Exactly 5 × 201 and 25 × 409 | ✅ | 5×201, 25×409 |
| No 5xx (e.g. PostgreSQL connection exhaustion) | ✅ | 0 |

| Metric | Value |
|---|---|
| Checkout latency from this laptop (incl. internet RTT) | p50 396 · p95 2996 · p99 4209 · max 4209 ms (n=30) |
| Wall time for 30 concurrent | 4213 ms |
| Scenario duration · peak PG connections · 503 BUSY retries | 12899 ms · 13 · 10 |

## What these results prove

- **No overselling under contention.** The conditional `UPDATE … WHERE qty + delta >= 0` plus the row lock serialises buyers of the same item; losers get a clean `409 OUT_OF_STOCK` and nothing is written for them (C1, C2, D1).
- **All-or-nothing checkout.** A multi-item cart that fails on its second item releases the first one (C2), and items are locked in `product_id` order so opposite-order carts never deadlock.
- **Idempotent submits.** Concurrent duplicates of one request produce one order and one stock decrement (C3), via the `UNIQUE(idempotency_key)` race handler.
- **Transactional outbox.** Every stock change and order writes its events in the same transaction (exact per-order counts, zero orphan events), the single relay publishes them in order, and OpenSearch converges to PostgreSQL (P1).
- **At-least-once delivery, exactly-once effect.** Duplicate and stale Kafka messages produce no extra confirmations, no extra alerts, and never roll the search index back (O1).

## Not covered (honest gaps)

- **Real payment capture is not part of StockHop checkout yet.** PAY1 tests the Razorpay *Test Mode* gateway-order API under concurrency and reads back the manually recorded 5-tab experiment; it cannot complete a UPI/card payment server-side. Pending-payment reservations, signature verification and webhooks are not implemented (see [11-razorpay-test.md](./11-razorpay-test.md)).
- **Single-instance local API.** Local scenarios use one Node process with a small pool; horizontal scaling is only exercised in D1.
- **Outage drills** (killing the indexer / Kafka mid-run) are not automated here; O1 covers the duplicate-delivery half of the crash case.
- Numbers are from one run on a free-tier stack and shared network; treat them as indicative, not SLAs.

## Cleanup performed

- consumers drained before cleanup: true
- restored 21 product×city rows to their original stock
- deleted 77 test orders with their items, confirmations, alerts and customers
- deleted 254 test carts
- restore propagated to OpenSearch in 764 ms; global index 90/90 in sync
- all stock back to original: true

## Re-run

```bash
npm run test:concurrency                  # full suite incl. the deployed race
npm run test:concurrency -- --no-deployed # local only
npm run test:concurrency -- --keep        # keep the test orders for inspection
```

Requires `.env` (Aiven PG, Kafka, OpenSearch; Razorpay test keys for PAY1) and the workers running (`npm run dev` or `npm run workers`).
