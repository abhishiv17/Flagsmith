# 15: Load Test on the Live Deployment

> **What this is.** A load test of the **deployed** StockHop on Aiven, not a local run. It drives the public URL the way real shoppers do and checks the database afterwards.
> **Re-run:** `npm run load:test` (all phases) or `npm run load:test -- --only=stock|search|checkout`. Source: [`scripts/load-test.ts`](../scripts/load-test.ts).

**Run:** Sat 21 Nov 2026, 6:40–7:00 pm IST · target `https://lucky-infinite-humpback.eur-1.aiven.app` · load generated from one laptop on the venue network in Bengaluru.

## Summary

| # | Scenario | Store that answers | Result | Headline |
|---|---|---|---|---|
| L1 | Live-stock polling: 25 → 200 shoppers, 12 cards each, every 1.5 s | **Valkey** | ✅ 0 errors at every step | Server time **1.4 ms p50**, 11 ms p95 up to 100 shoppers (66 req/s). 125 req/s at 200 shoppers |
| L2 | Typo search: 10 → 50 users back-to-back | **OpenSearch** | ✅ 0 errors at every step | OpenSearch `took` **13 → 39 ms p50** at 21 → 79 req/s |
| A/B | Same polling load, original OpenSearch-only path vs Valkey | OpenSearch → **Valkey** | ✅ 0 errors either way | Server p50 **~330 ms → ~2 ms**; OpenSearch search queries **→ 0**, its CPU **18–23% → 2–4%**; 200 shoppers: **+60%** polls served, p99 **11.3 s → 0.4 s** |
| L3 | Checkout stampede: 40 shoppers, 5 units, all at once | **PostgreSQL** | ✅ correct · ⚠️ slow | **Exactly 5 orders, stock 0, nothing oversold.** But 16/40 got `503 BUSY` and checkout p50 was 22 s (cause below) |
| L3′ | **Same stampede after moving PostgreSQL to Frankfurt**, next to the app | **PostgreSQL** | ✅ correct · ✅ fast | Exactly 5 orders, stock 0. **0 × `503`**, checkout p50 **22 s → 0.53 s**, whole race over in **0.7 s** (was 31 s) |
| L4–L7 | doc/21 features: type-ahead, shop storefronts, presence, bought together ([below](#new-shopping-features-doc21-type-ahead-shops-presence-bought-together)) | **OpenSearch · PostgreSQL · Valkey · ClickHouse** | ✅ 0 errors · ⚠️→✅ storefronts | Storefronts were pool-bound (7.6 req/s at 50 shoppers); a 1.5 s shared read made it **36.4 req/s, p50 3.8 s → 0.37 s**. Type-ahead 74 req/s at ~200 ms p50; live p99 10.4 s → 2.5 s after a fail-fast fix |

**One-line takeaway:** correctness held under every load. Read paths scale (Valkey and OpenSearch). The write path was limited by **distance**: the app in Frankfurt and PostgreSQL in Singapore were about 160 ms apart. We moved the databases to Frankfurt, and the same checkout stampede became **~40× faster with zero errors** ([below](#after-moving-the-databases-next-to-the-app)).

## Before vs after Valkey (A/B on the live site)

**Run:** Sat 21 Nov 2026, 6:56–7:01 pm IST · `npm run load:test -- --compare` · raw results: [`data/load-test-ab-2026-11-21.json`](./data/load-test-ab-2026-11-21.json).

**Method:** the same polling load (12 cards per shopper, every 1.5 s, 20 s per run) is sent to the live site twice per step:
- **Before** uses `/api/stock?cache=off`, which runs the **original, unchanged** OpenSearch-only code: an `mget` for this city's documents, plus a second OpenSearch search for "nearest city with stock" whenever an item is sold out.
- **After** is the normal endpoint: one pipelined Valkey read.

The two runs alternate at each step, so both see the same network and cluster conditions. Around every run, the script reads **OpenSearch's own node statistics** (`_nodes/stats`): search queries executed, documents fetched, time OpenSearch spent on them, and node CPU (sampled every 4 s).

### What the shopper's request costs (server time, inside the app)

| Shoppers | Before p50 | **After p50** | Before p95 | **After p95** | Before p99 | **After p99** | Errors |
|---|---|---|---|---|---|---|---|
| 25 | 331 ms | **2.0 ms** | 436 ms | **6.0 ms** | 655 ms | **98 ms** | 0 / 0 |
| 50 | 330 ms | **1.8 ms** | 507 ms | **4.7 ms** | 714 ms | **80 ms** | 0 / 0 |
| 100 | 350 ms | **1.9 ms** | 902 ms | **93 ms** | 10,470 ms | **190 ms** | 0 / 0 |
| 200 | 503 ms | **91 ms** | 5,806 ms | **298 ms** | 11,284 ms | **400 ms** | 0 / 0 |

### What the shopper sees (client time, Bengaluru → Frankfurt and back)

| Shoppers | Polls/s achieved, before → **after** | Client p50, before → **after** | Client p95, before → **after** |
|---|---|---|---|
| 25 | 16.6 → **16.6** | 522 → **216 ms** | 857 → **418 ms** |
| 50 | 32.9 → **33.3** | 537 → **215 ms** | 990 → **559 ms** |
| 100 | 60.3 → **66.2** | 684 → **211 ms** | 1,976 → **586 ms** |
| 200 | 80.9 → **129.3** (+60%) | 995 → **413 ms** | 6,799 → **959 ms** |

At 200 shoppers the old path couldn't keep up. Polls took so long that each browser fell behind its 1.5 s schedule, so only 81 polls/s got through instead of ~133. With Valkey, 129 polls/s got through. A shopper's live stock therefore refreshes on time, with the card flip arriving within ~1.5 s instead of several seconds late.

### What OpenSearch had to do (from OpenSearch's own `_nodes/stats`)

| Shoppers | Search queries, before → **after** | Docs fetched, before → **after** | OpenSearch busy time, before → **after** | Node CPU avg (max), before → **after** |
|---|---|---|---|---|
| 25 | 188 → **0** | 6,144 → **2,160** | 638 → **149 ms** | 9.8% (17%) → **4.0% (7%)** |
| 50 | 328 → **0** | 9,912 → **2,016** | 1,352 → **123 ms** | 18.2% (25%) → **3.0% (4%)** |
| 100 | 654 → **0** | 17,484 → **2,016** | 2,472 → **151 ms** | 18.4% (32%) → **3.4% (5%)** |
| 200 | 916 → **0** | 19,992 → **0** | 3,528 → **0 ms** | 23.0% (28%) → **2.2% (3%)** |

The "after" column is **not** from the test: 100% of its requests were answered by Valkey (`X-Stock-Source: valkey`). The ~2,000 document fetches are background traffic present in both columns, mostly the `/ops` page's index-drift check, which fetches every product document every few seconds.

### What this means

- **Every live-stock poll used to cost OpenSearch work:** 12 document fetches (one per card on screen; e.g. (17,484 − 2,016 background) ÷ 1,205 polls ≈ 12.8 at 100 shoppers), plus a "nearest city" search query whenever something was sold out (≈0.55 per poll). With Valkey it costs **nothing**. Search queries fell to zero, and at 100 shoppers OpenSearch spent **94% less time** serving the shop (2,472 → 151 ms per 20 s).
- **OpenSearch CPU** under polling load dropped from **18–23%** to the **2–4%** idle baseline. That headroom now goes to what OpenSearch is for: typo-tolerant search ([L2](#l2-search-opensearch)).
- **Latency inside the app fell ~170×** at typical load (p50 ~330 ms → ~2 ms). The old path paid **two** intercontinental round trips per poll (Frankfurt → Singapore, `mget` + `search`); Valkey is in Europe, next to the app, and answers in one pipelined round trip.
- **The tail is where it matters most.** At 100 shoppers, the slowest 1% of polls went from **10.5 s to 0.19 s**. A 10-second-stale "1 left" is exactly how two people end up chasing the same last unit.
- **Correctness is unchanged.** Valkey only displays stock; PostgreSQL still allocates it (L3). Valkey writes are version-guarded, so a replayed or late event can't make a sold-out item reappear.

## After moving the databases next to the app

**What changed (21 Nov, ~7:15 pm IST):** L3 showed that checkout was limited by distance, so PostgreSQL and OpenSearch were migrated from **DigitalOcean Singapore** to **DigitalOcean Frankfurt**, the same city as the apps and Valkey. Aiven moved the running services with no downtime. Hostnames, credentials and prices stayed the same, and no code or config changed. Raw results: [`data/load-test-fra-2026-11-21.json`](./data/load-test-fra-2026-11-21.json).

### Checkout stampede: before → after (same test, same live site)

| | Databases in Singapore (L3) | **Databases in Frankfurt** |
|---|---|---|
| Orders in PostgreSQL | 5 ✅ | **5** ✅ |
| Stock afterwards | 0 ✅ | **0** ✅ |
| Cart adds that got through | 23 of 40 | **40 of 40** |
| Responses | 5 × `201` · 19 × `409` · **16 × `503 BUSY`** | **5 × `201` · 35 × `409` · 0 × `503`** |
| Checkout p50 / p95 | 22 s / 29 s | **0.53 s / 0.69 s** |
| Whole race, first request to last answer | 31 s | **0.7 s** |

Every shopper now gets a definite answer within a second: 5 get the product and 35 get a clean "sold out". The ~0.5 s that's left is mostly the network from Bengaluru, where the load generator ran, to Frankfurt and back. Inside Frankfurt, a database round trip went from ~160 ms to about a millisecond, so a checkout holds its connection for milliseconds and the 5-connection pool no longer forms a queue.

### Live-stock polling (Valkey): unchanged, as expected

Valkey was already next to the app, so polling stayed where it was: **0 errors** at every step, server p50 **1.8 ms** at 25–100 shoppers, and **130 polls/s** at 200 shoppers, where the `web` container's CPU is still the limit.

### Search (OpenSearch): more throughput, slower queries on the new node

| Users | Req/s before → after | Client p50 before → after | OpenSearch `took` p50 before → after |
|---|---|---|---|
| 10 | 21 → **33** | 522 → **274–286 ms** | 13 → 30–36 ms |
| 25 | 50 → **56** | 530 → **411–413 ms** | 18 → 80–93 ms |
| 50 | 79 → 60–72 | 609 → 683–762 ms | 39 → 237–271 ms |

Ranges cover two runs, both with 0 errors. Removing the Singapore hop cut the time shoppers wait by about half at normal load. But the new OpenSearch node itself took longer per query, and at 50 back-to-back users that cancelled out the gain. Its query cache was empty right after the migration, which points to a cold node. We report it as measured and will re-run once it has warmed up. Search is not on the checkout path, and this is a deliberately harsh closed-loop test.

## New shopping features (doc/21): type-ahead, shops, presence, bought together

**Run:** Sun 22 Nov 2026 · `npm run load:test -- --url=http://127.0.0.1:4100 --only=new` · raw:
[`data/load-test-doc21-local-2026-11-22.json`](./data/load-test-doc21-local-2026-11-22.json).

> **Where it ran.** These features weren't deployed yet, so the app ran **on a laptop in Bengaluru**
> against the real Aiven services in **Frankfurt**. Every database or search call therefore pays about
> 150 ms each way that the deployed app (next to the services) doesn't. Read these as a **worst case**.
> Errors and throughput limits carry over; absolute latency will be lower once deployed.

| # | Scenario | Load | Throughput | Server p50 / p95 | Errors |
|---|---|---|---|---|---|
| L4 | **Type-ahead**: shoppers typing letter by letter, one `/suggest` per keystroke | 10 → 25 → 50 typing | 25 → 61 → **74 req/s** | 208 / 517 → 229 / 500 → **197 / 623 ms** | **0** |
| L5 | **Shop storefronts**: browsing + searching inside a shop (typos), shop-name searches | 10 → 25 → 50 shoppers | 4.9 → 6.0 → **7.6 req/s** ⚠️ | 759 / 1,453 → 2,048 / 3,071 → **3,807 / 8,461 ms** ⚠️ | 0 |
| L5′ | **Same, after the fix below** | 10 → 25 → 50 shoppers | 8.3 → 22.7 → **36.4 req/s** | 352 / 1,207 → 219 / 1,252 → **372 / 1,773 ms** | **0** |
| L6 | **Presence**: open product pages, a heartbeat every 5 s | 50 → 100 → **200 pages** | 10 → 20 → **40 beats/s** | client p50 **3.5 ms**, p99 18 ms | **0** |
| L7 | **Bought together**: product pages loading `/together` (ClickHouse + OpenSearch) | 10 → 25 → 50 shoppers | 5.4 → 14.5 → **28.5 req/s** | 577 / 1,464 → 502 / 1,158 → **485 / 1,178 ms** | **0** |

### On the live site (after deploying)

**Run:** Sun 22 Nov 2026, minutes after the deploy · target the Aiven App Runtime URL · load from the
same laptop in Bengaluru · raw: [`data/load-test-doc21-live-2026-11-22.json`](./data/load-test-doc21-live-2026-11-22.json),
storefront re-run [`data/load-test-doc21-live-shops-rerun-2026-11-22.json`](./data/load-test-doc21-live-shops-rerun-2026-11-22.json).
L4 and L6 were re-run after the type-ahead fix and presence `Server-Timing` went live:
[`data/load-test-doc21-live-typeahead-2026-11-22.json`](./data/load-test-doc21-live-typeahead-2026-11-22.json),
[`data/load-test-doc21-live-presence-2026-11-22.json`](./data/load-test-doc21-live-presence-2026-11-22.json).
Here the app sits next to its services, so **server** time is the real cost. **Client** time adds the
Bengaluru → Frankfurt round trip (about 230 ms).

| # | Scenario | Load | Throughput | **Server p50 / p95** | Client p50 | Errors |
|---|---|---|---|---|---|---|
| L4 | Type-ahead (after the fix) | 10 → 25 → 50 typing | 25 → 49 → **64 req/s** | 15 / 98 → 50 / 307 → **103 / 607 ms** | 218 → 445 ms | 0 · 0 · **0.7%** (fast 503s) |
| L5 | Shop storefronts (warm re-run) | 10 → 25 → 50 shoppers | 9.3 → 22.7 → **34.3 req/s** | 15 / 176 → 20 / 302 → **105 / 847 ms** | 289 → 711 ms | **0** |
| L6 | Presence heartbeats (Valkey) | 50 → 100 → 200 pages | 10 → 20 → **40 beats/s** | 2.7 / 78 → 3.3 / 103 → **104 / 1,001 ms** | 541 → 1,093 ms | **0** |
| L7 | Bought together | 10 → 25 → 50 shoppers | 6.6 → 15.6 → **30.7 req/s** | 23 / 598 → 17 / 899 → **15 / 299 ms** | 233 → 263 ms | **0** |

- **Storefronts:** the first live run's 10-shopper stage was slow (2.1 s p50, 2.2 req/s). That was the
  app's first minutes after the deploy: cold pool, and the shops index still building. The warm
  re-run above is the steady state.
- **Presence:** `Server-Timing` now reports the write itself: `presence;desc="valkey";dur=3.2`. At 50
  and 100 open pages a heartbeat costs **about 3 ms** at the server. The ~0.55 s client figure is mostly
  **connection setup**: Node's HTTP client drops idle connections after 4 s, these virtual pages beat
  every 5 s, so nearly every beat paid a new TLS handshake to Frankfurt. Browsers keep connections for
  minutes. At 200 pages the server p50 rises to ~100 ms and p95 to ~1 s while every beat is also a
  fresh TLS connection at the app; still 0 errors, and "Live now" tolerates it (a view counts for 15 s).
- **Type-ahead tail (found here, fixed below):** before the fix, p99 at 50 typers was **~10.4 s** in
  *both* runs while p95 stayed under 0.7 s: the OpenSearch client's 5 s timeout plus a retry. After the
  fix, client p99 at 50 typers is **2.5 s**, and 7 of 964 keystrokes (0.7%) got a fast 503 instead of
  waiting. The dropdown keeps its last list when that happens.

### What the test found, and the fix

**Shop storefronts didn't scale.** Going from 10 to 50 shoppers raised throughput only from 4.9 to
7.6 req/s while p50 went from 0.76 s to 3.8 s. Every storefront request ran three PostgreSQL queries
(slug, shop counts, all ~220 offers) through a pool of **5 connections**, and every open storefront
tab repeats the request every 4 s. The pool was the queue.

**Fix** (`server/lib/shops-index.ts`): shop counts and each shop's offer rows are shared for **1.5 s**.
Concurrent requests wait on the same promise, so one query serves everyone looking at that shop in the
window, and the slug is resolved from the shared counts. Stock on a storefront is still at most 1.5 s
old (it polls every 4 s anyway). Result at 50 shoppers: **4.8× the throughput (7.6 → 36.4 req/s),
10× lower p50 (3.8 s → 0.37 s)**, 0 errors.

**Second fix, type-ahead tail** (`server/lib/suggest.ts`): suggestion queries now use a **2 s timeout
and no retry**. A late suggestion is worthless (the shopper has typed on, and the box drops stale
replies), so a stalled query now fails fast and the dropdown keeps its last list. Measured live afterwards:
p99 **10.4 s → 2.5 s** at 50 typers, at the cost of a 0.7% fast-fail rate at that stage. Shop-name lookups in the dropdown
fall back to PostgreSQL on timeout.

### Notes

- **Type-ahead** holds about 200 ms p50 at 74 req/s. That is 50 people typing at once, each keystroke
  one OpenSearch query; nearly all of it is the Bengaluru → Frankfurt hop. One p99 outlier (10.5 s)
  in the 50-user stage came from a slow OpenSearch reply, not from errors.
- **Presence** writes cost about 4 ms (memory here; Valkey when deployed). 200 open product pages are
  40 writes/s, far from any limit.
- **Bought together**: co-purchases come from ClickHouse once per product set every 5 minutes
  (cached), so steady load is mostly OpenSearch mgets. Latency *falls* as load rises because the cache
  warms.

## Where things ran

```
 load generator (Bengaluru) ──► web  (Aiven App Runtime, AWS Frankfurt, 0.2 vCPU)
                                 ├── Valkey      (Aiven, DigitalOcean Frankfurt)   live-stock reads
                                 ├── OpenSearch  (Aiven, DigitalOcean Singapore → Frankfurt)   search
                                 └── PostgreSQL  (Aiven, DigitalOcean Singapore → Frankfurt)   checkout, carts
                                workers (Aiven App Runtime, Frankfurt) ── Kafka (Aiven, Bengaluru)
```

L1, L2, L3 and the A/B ran with the databases in Singapore. The section above reran the tests after the move to Frankfurt.

**How to read the numbers:**
- **Server time** is measured inside the app and returned in the `Server-Timing` header. For search it is OpenSearch's own `took`.
- **Client time** adds the network from Bengaluru to Frankfurt and back (about 190 ms).

## L1: Live-stock polling (Valkey)

Every open product page polls `/api/stock` for the cards on screen. Since the Valkey change, that is **one pipelined Valkey read** that returns every city for every card. The same reply answers both "how many here" and "nearest city with stock". Before, it took two OpenSearch queries.

| Shoppers | Req/s | Errors | Server p50 | Server p95 | Server p99 | Client p50 | Client p95 | Answered by |
|---|---|---|---|---|---|---|---|---|
| 25 | 16.6 | 0% | 1.4 ms | 181.5 ms | 718 ms | 195 ms | 671 ms | Valkey 312 · OpenSearch 20 *(cold cache)* |
| 50 | 33.0 | 0% | 1.5 ms | 7.5 ms | 97 ms | 201 ms | 257 ms | Valkey 659 |
| 100 | 66.4 | 0% | 1.4 ms | 11.1 ms | 101 ms | 196 ms | 324 ms | Valkey 1,327 |
| 200 | 125.3 | 0% | 98.4 ms | 501 ms | 1,301 ms | 467 ms | 2,151 ms | Valkey 2,506 |

**Valkey vs OpenSearch, same endpoint:** the 20 cold-cache requests at the start took about **180 ms** each on the OpenSearch path. After that, every request was a Valkey hit at **about 1.4 ms**: more than **100× faster**. Each miss refilled Valkey, so after the first poll per product everything came from Valkey.

**Why it slowed at 200 shoppers:** Valkey still answered every request. The bottleneck was the `web` container's CPU: it runs on the smallest plan (0.2 vCPU), and a single Node.js process saturates at about 125 req/s. Server time rose and errors stayed at zero.

## L2: Search (OpenSearch)

Closed loop: each user fires the next query as soon as the last one returns. Queries include typos ("bluetoth earphones", "water botle", "earfones") and are spread across the three cities.

| Users | Req/s | Errors | OpenSearch p50 | OpenSearch p95 | Client p50 | Client p95 |
|---|---|---|---|---|---|---|
| 10 | 21.1 | 0% | 13 ms | 37 ms | 522 ms | 623 ms |
| 25 | 49.7 | 0% | 18 ms | 59 ms | 530 ms | 750 ms |
| 50 | 78.5 | 0% | 39 ms | 141 ms | 609 ms | 1,075 ms |

OpenSearch itself stays fast as load grows. Most of the ~520 ms the client sees is distance: Bengaluru → Frankfurt (app) → Singapore (OpenSearch) and back.

## L3: Checkout stampede (PostgreSQL)

**Setup:** 40 shoppers each put the same product (Orbit Smartwatch, Delhi) in their cart. Stock is then set to **5**, and all 40 checkouts are fired at the same moment against the live site. Afterwards the script checks PostgreSQL directly. It restores the product's stock and clears the test carts when done.

| Check | Result |
|---|---|
| Orders in PostgreSQL | **5** ✅ (exactly the units available) |
| Stock afterwards | **0** ✅ (never negative) |
| Responses | 5 × `201 Created` · 19 × `409` (sold out / nothing to buy) · **16 × `503 BUSY`** ⚠️ |
| Cart adds that got through | 23 of 40 ⚠️ (the rest got `503 BUSY`) |
| Timing | 31 s wall clock · checkout p50 **22 s**, p95 29 s ⚠️ |

**What held:** the guarantees. One transaction allocates stock under a row lock with a conditional `UPDATE … WHERE qty + delta >= 0`, so even with requests timing out around it, exactly 5 orders exist and nothing was oversold. `503 BUSY` is the designed fail-fast answer ("try again", nothing charged), not a crash.

**Why it was slow:**
1. **Distance.** Every database statement crosses Frankfurt ↔ Singapore (about 160 ms). A checkout makes about 7 round trips, so it takes about 1 s even when nothing else is happening. The stock-row lock is held for only about 3 of them: the code already writes customer, order, lines, event and cart close in **one** statement ([`server/domain/checkout.ts`](../server/domain/checkout.ts)).
2. **Few connections.** The `web` app has 5 database connections, and the Developer PostgreSQL plan has 15 in total, shared with the workers and every laptop. Forty one-second checkouts behind five connections form a queue. Anyone who waited more than 10 s (`PG_CONNECT_TIMEOUT_MS`) got `503 BUSY`. During the run, 5 connections were held by laptops on the venue network.

An earlier run with the app **next to** the database (Vercel functions in Singapore, [12](./12-metrics.md) D1) handled 30 shoppers for 5 units cleanly. That isolates distance as the cause.

## What we changed because of this test

| Change | Why | Status |
|---|---|---|
| **Aiven for Valkey** live-stock cache | Take the most frequent read (every open browser, every 1.5 s) off OpenSearch and answer it in about 1 ms | ✅ Live: L1 above |
| Valkey writes guarded by version | A replayed or late event can never move displayed stock backwards (same rule as the OpenSearch index) | ✅ Live |
| Laptops no longer run workers | Every local process uses scarce PostgreSQL connections; the workers run once, in the cloud | ✅ Done |
| Load test cleans up after itself | Its carts *claim* stock for 15 min; left behind, they would block real shoppers | ✅ In the script |
| **PostgreSQL and OpenSearch moved to Frankfurt**, next to the apps | L3: checkout was limited by the 160 ms Frankfurt ↔ Singapore round trip | ✅ Done: checkout p50 22 s → 0.53 s, 0 × `503` |

## Next steps (ordered by impact)

| # | Step | Expected effect |
|---|---|---|
| ✅ | ~~Move PostgreSQL and OpenSearch to Europe~~ | Done. See [After moving the databases](#after-moving-the-databases-next-to-the-app) |
| 1 | Re-run search once the migrated OpenSearch node has warmed up; if queries are still slower, look at its plan or shard settings | Confirms whether the higher `took` is a cold cache or the new node |
| 2 | Give `web` more CPU (Startup-50, 0.5 vCPU) or a second instance | Moves the L1 knee beyond 200 shoppers |
| 3 | PostgreSQL connection pooling (PgBouncer) | Many app connections share a few database slots. Not available on the Developer plan; needs a Startup plan |

## Outage drill: the event pipeline switched off on the live site

**What we did (21 Nov, ~8:53 pm IST):** we powered off the whole `workers` app in Aiven (relay, indexer, notifier, monitor), placed 3 real orders for Travel Bottle in Bengaluru, then powered it back on. Raw log: [`data/outage-drill-2026-11-21.txt`](./data/outage-drill-2026-11-21.txt).

| Moment | Checkout | PostgreSQL stock | Outbox | Store console sync | Confirmations |
|---|---|---|---|---|---|
| Before | n/a | 8 | 0 | 198/198 ✓ | n/a |
| **Workers off, 3 orders** | **3 × `201`**, ~0.4 s each | **5** | **6 events waiting** | **197/198**: the mismatch is visible | 0/3 |
| Workers back (+43 s from power-on) | n/a | 5 | **0**: all 6 published at once | 198/198 within 4 s | **3/3** within 4 s |
| Kafka lag 0 | n/a | 5 | 0 | 198/198 ✓ | 3/3 |

**What it proves:**
- **Shoppers can still buy when the pipeline is down.** Checkout only needs PostgreSQL.
- **Nothing is lost.** The order and its events were committed together, and they waited in the outbox until the relay came back.
- **The Store console shows the problem while it's happening.** Sync dropped to 197/198, then healed on its own.

**What it found (and we fixed):**
- **The problem:** the stock shown to shoppers stayed at the pre-outage 8 for **~4 minutes** after everything else had recovered. The search index had 5; the Valkey cache still had 8.
- **The cause:** a freshly started indexer creates its Valkey connection on its first write. That first write, which is the whole catch-up batch after an outage, arrived while the connection was still opening, and was skipped. The stale entry lived until its 5-minute expiry.
- **The fix (`1a86ade`):** the indexer opens the Valkey connection at startup, and write-through waits up to 5 s for it. Readers never wait; they fall back to OpenSearch.
- **Result:** after the fix, a restock reaches shoppers through Valkey in **1.0–1.2 s**, end to end. That path is PostgreSQL commit → outbox → Kafka (Bengaluru) → indexer → Valkey → shop (Frankfurt).

## How to reproduce

```bash
npm run load:test                           # all three phases against the live URL
npm run load:test -- --only=stock           # just L1
npm run load:test -- --url=https://… --out=report.json
```

L3 needs `DATABASE_URL` locally: it uses **one** database connection to set stock before the race, verify the result and restore everything afterwards. It never touches the demo product (AUD-001).
