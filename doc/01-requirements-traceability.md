# 01: Requirements Traceability

Every line in the **brief** (B-, D-, R-) and every promise in our **submission slides** (S-) maps to a concrete implementation and to the moment in the demo that proves it. If a row has no "proven by", judges won't see it.

Status legend: ⬜ planned · 🟨 in progress · ✅ done & demo-verified

## A. Brief: functional requirements

| ID | Requirement (brief wording) | Our implementation | Proven in demo by | Status |
|---|---|---|---|---|
| B1 | Customers can **browse** products | Home grid by category + product detail page (`/`, `/p/:id`) | Demo step 1 | ⬜ |
| B2 | **Add items to a cart** | Cart stored in PG, keyed by session cookie + city | Demo step 2 (reload, cart persists) | ⬜ |
| B3 | **Place orders** | `POST /api/checkout`: single PG transaction | Demo step 3 | ⬜ |
| B4 | Storefront is **fast** | Search served by OpenSearch; UI shows `took` ms; stampede prints p50/p95 checkout latency | Search badge + stampede output | ⬜ |
| B5 | **Stays accurate when stock changes** | Atomic conditional decrement in PG; Kafka → index sync; cards poll the index and flip live | Two-window demo (step 3) | ⬜ |
| B6 | Helps shoppers find things **without fuss** | Fuzzy + synonym search, facets, stock-aware ranking | "bluetoth earphones" query | ⬜ |
| B7 | PG stores **products, prices, customers, carts, orders, stock** | Tables: `products`, `customers`, `carts`, `cart_items`, `orders`, `order_items`, `inventory` | `/ops` + SQL on request | ⬜ |
| B8 | Last item: **two people can't both get it** | `UPDATE … WHERE qty >= n` under row lock + `CHECK (qty >= 0)` | Two-window + 50-vs-5 stampede | ⬜ |
| B9 | Post events to Kafka: **"order placed", "inventory changed"** | Outbox → relay → topics `orders.placed`, `inventory.changed` (event types `OrderPlaced`, `InventoryChanged`) | `/ops` event feed | ⬜ |
| B10 | Listeners react, e.g. **"reduces inventory count and sends a confirmation"** | `notifier` consumer sends confirmation; `search-indexer` updates the **inventory view** in OpenSearch. PG deduction is deliberately synchronous (see [03 §7](./03-architecture.md#7-why-kafka-never-deducts-stock)) | Order page "Confirmation sent ✓" + `/ops` | ⬜ |
| B11 | OpenSearch: fast, **typos**, filter by **category, price, city** | `products` index, one doc per product×city; fuzzy clause + filters + facets | Demo step 1 | ⬜ |
| B12 | Flow: order → PG → Kafka → consumer updates inventory & **keeps index in sync** | Exactly this, plus the outbox so no event is lost | `/ops` trail + kill-indexer drill | ⬜ |

## B. Brief: deliverables

| ID | Deliverable | How we satisfy it | Status |
|---|---|---|---|
| D1 | Working demo: **browsing, searching, add to cart, place order** | Demo steps 1–3, rehearsed 3×, backup video recorded | ⬜ |
| D2 | Show **all three services doing real work**: order → Kafka event, consumer reacts, search from OpenSearch | `/ops` page: outbox pending, consumer lag per group, live event feed, index-drift check (PG vs OpenSearch versions) | ⬜ |
| D3 | **Short pitch** | 3-min pitch; deck made with **Qwen** | ⬜ |

## C. Brief: ground rules

| ID | Rule | How we comply | Status |
|---|---|---|---|
| R1 | Any language/framework; PG, Kafka, OpenSearch fixed | React (Vite) + Node/Express; all three on **Aiven** | ⬜ |
| R2 | **Credentials out of repo**, use env vars | `.env` + `certs/` git-ignored; `.env.example` committed; pre-commit check in [07](./07-build-plan.md) | ⬜ |
| R3 | **Originality**, "your own flair" | City-aware "also in Mumbai" hint, live stock flip, ops view, proof drills | ⬜ |
| R4 | "Everything runs on Aiven" | One team Aiven project `stockhop`; all three services on Developer tier (trial credits) | ✅ provisioned |

## D. Our submission: promises the judges have already seen

Anything on a slide that the demo doesn't show will look like a broken promise.

| ID | Slide | Promise | Implementation | Status |
|---|---|---|---|---|
| S1 | 1, 3 | City-aware storefront ("Local discovery. Real stock.") | City picker; every listing shows that city's stock | ⬜ |
| S2 | 2 | **"bluetoth earphones" · Bengaluru · under ₹1,500** works | Seed guarantees ≥2 matching products in BLR under ₹1,500; this exact query opens the demo | ⬜ |
| S3 | 3 | 01 Choose your city | City picker modal on first visit, switch in header | ⬜ |
| S4 | 3 | 02 Typos, category and price filters | Fuzzy search + category chips + price slider/presets | ⬜ |
| S5 | 3 | 03 Save your cart: continue after reload | PG-backed cart via `sh_sid` cookie | ⬜ |
| S6 | 3 | 04 An order ID **or** an out-of-stock message | `201 {orderNumber}` / `409 OUT_OF_STOCK` with the item named | ⬜ |
| S7 | 3 | Mockup products: **Everyday Buds ₹1,299 (1 left), Pocket Speaker ₹999 (6 left), Travel Bottle ₹699 (8 left)** in Bengaluru | Seeded with exactly these values so the live app matches the slide | ⬜ |
| S8 | 4 | React + Node.js/Express | As stated | ⬜ |
| S9 | 4 | Check stock + save order + outbox event: **commit together, or roll back** | Single transaction in `checkout` service | ⬜ |
| S10 | 4 | Outbox publisher | `relay` worker process | ⬜ |
| S11 | 4 | Kafka: OrderPlaced / InventoryChanged | Two topics, keyed | ⬜ |
| S12 | 4 | Index consumer: **apply newer stock versions** | `version_type=external` with PG `inventory.version` | ⬜ |
| S13 | 4 | "Kafka updates search; it **never deducts stock a second time**" | Indexer only writes OpenSearch; invariant I-2 in [03](./03-architecture.md) | ⬜ |
| S14 | 5 | **2 requests. 1 unit. 1 successful order.** | Two-window demo + stampede script | ⬜ |
| S15 | 5 | "Then show: Kafka event → consumer → search update" | Live card flip read from the index + `/ops` feed | ⬜ |
| S16 | 6 | 30 products / 3 cities | Seed: 30 products × BLR/MUM/DEL = 90 inventory rows | ⬜ |
| S17 | 6 | One web app + API/worker processes | `api`, `relay`, `indexer`, `notifier` processes | ⬜ |
| S18 | 6 | Budget: "free tier / trial if available" | Aiven trial credits ($50, no card) on Developer tier, a few $ for the event; Vercel Hobby | ✅ |
| S19 | 6 | Scale path: product-city docs, keyed partitions, more index consumers | Product×city docs are built in; keyed partitions are real (2 per topic); scaling is a spoken answer | ⬜ |
| S20 | 6 | "For the retailer: fewer oversold orders" | We'll claim **zero** and prove it (stampede) | ⬜ |
