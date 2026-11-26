# 02: Gap Analysis (Submission vs Brief vs What Wins)

Our 6-slide submission has a strong core: outbox, version-guarded indexing, and "Kafka never deducts stock". But it **misses some things the brief explicitly asks for**, **leaves several behaviours undefined**, and **doesn't account for free-tier limits**. Each gap below has a fix and a priority.

**Priority:** 🔴 MUST (missing = losing points or a broken demo) · 🟠 SHOULD (big score impact, cheap) · 🟢 COULD (only after feature freeze criteria are met)

---

## 1. Missing vs the brief 🔴

| # | Gap | Evidence | Fix |
|---|---|---|---|
| G1 | **No "send confirmation to customer" consumer.** | The brief's own example: *"order placed → a listener … sends a confirmation to customer."* Slide 4 has only an index consumer. | Add a `notifier` consumer group on `orders.placed`. It writes a `notifications` row (simulated email). The order page shows **"Confirmation sent ✓"** once it lands, so the consumer's work shows up in the main shopper flow. |
| G2 | **No customers.** | Brief: PG stores *"products, prices, **customers**, carts, orders"*. Not mentioned anywhere in the submission. | Guest checkout collects name, email and phone; we upsert into `customers` by email. No login (out of scope). |
| G3 | **Browsing isn't designed.** The submission is search-first. | Brief D1: demo must cover *"**browsing**, searching, adding to cart, placing an order"*. | Home page: category chips + grid (OpenSearch `match_all` with city filter). Product detail page reads **PG** (authoritative price + stock in all 3 cities). |
| G4 | **"Show all three services doing real work" has no mechanism.** | Brief D2. Slide 5 just says "then show: Kafka event → consumer → search update" but nothing on screen shows it. | `/ops` page: outbox pending, consumer lag per group, live event feed, **index drift check** (PG version vs OpenSearch version for all 90 docs → "90/90 in sync"). |
| G5 | **The brief says a listener "reduces inventory count"; our design doesn't.** | Brief table row for Kafka vs slide 4 footer. | The design is correct, but **we must defend it out loud** (see [03 §7](./03-architecture.md#7-why-kafka-never-deducts-stock)). Wording: the consumer updates the **inventory view** (search index); the **allocation** happens once, in PG. Put this on the architecture slide. |

## 2. Under-specified in the submission: decisions now made 🔴

These were undefined. Undefined behaviour breaks during a demo. The decisions are final unless the team objects in the next hour.

| # | Question | Decision | Why |
|---|---|---|---|
| G6 | How does the search index get its **initial** data? | `scripts/seed.js` writes PG **and** inserts `InventoryChanged(reason=seed)` outbox rows, so the index is built through the same pipeline. `scripts/reindex.js` can also rebuild directly from PG (version-guarded, idempotent). | Seeding through the pipeline proves the pipeline. Reindex is the recovery tool. |
| G7 | Can anything change stock **without** an outbox event? | **No, never** (invariant I-1). Seed, checkout and admin restock all write `inventory` + `outbox` in one transaction. | Otherwise the index drifts silently. |
| G8 | Multi-item order where **one** item is short? | **All-or-nothing.** Roll back and return `409` naming each short item with the quantity available. | Matches the slide's "commit together, or roll back". Partial orders confuse the demo. |
| G9 | Cart has qty 3, only 2 left? | Cart page shows live availability and a warning; checkout is the only place that decides. | Slide 2: "Only checkout can safely allocate it." |
| G10 | Shopper **switches city** with items in cart? | Carts are per `(session, city)`. Switching city shows that city's cart; the other is kept. A banner says "You have 2 items in your Bengaluru cart". | Stock is per city, so a cart can't span cities. |
| G11 | Price changes between add-to-cart and checkout? | Checkout always uses the **current PG price**; `order_items.unit_price_paise` snapshots it. | Standard practice. Price editing is out of scope anyway. |
| G12 | **Double-click / retry** on Place Order? | Client generates an `idempotencyKey` (UUID) per checkout attempt; `orders.idempotency_key UNIQUE`; a repeat returns the same order. | Without it, a retry looks like a duplicate order. A judge may click twice. |
| G13 | Money type? | Integer **paise** everywhere; format with `Intl.NumberFormat('en-IN', {style:'currency', currency:'INR', maximumFractionDigits:0})`. | No float rounding bugs. |
| G14 | Which 3 cities? | **Bengaluru (BLR), Mumbai (MUM), Delhi (DEL).** | Slide 2 uses Bengaluru; the others are obvious. |

## 3. Hosting reality: not considered in the submission 🔴

**Resolved 21 Nov:** all three services run on Aiven's **Developer tier, paid from the $50 trial credits** (no card). This sidesteps the free tier's idle power-off and its 5-topic / 2-shard limits. Details in [10](./10-aiven-setup.md).

| Constraint (as provisioned) | Impact on us | Design response |
|---|---|---|
| **PG Developer: 15 connections max**, 1 CPU / 1 GB | Vercel can spin up several function instances; each has its own pool. A 50-request stampede could exhaust connections. | `PG_POOL_MAX=5`; stampede measured at CP2 against the deployed URL; if connections run out, run the stampede against the local API and say so. |
| Vercel functions can't run Kafka consumers or long SSE streams | The "live-ui" consumer idea doesn't fit. | Live cards poll the **OpenSearch** index (ADR-6); consumers + relay + lag monitor run on a worker host (ADR-11). |
| Trial credits last 30 days / $50 | Fine for the event (~$1–5). Services power off after the trial unless a card is added. | Nothing to do; after the event, delete or downgrade to Free. |
| One project for the team | Teammates need access. | Invite teammates to project `stockhop` (Aiven → Admin → Users). |

## 4. Gaps that cost points on judging 🟠

HackBriven's reported judging axes (from a LinkedIn post, **confirm at the venue**) are Innovation, Technical Execution, Presentation and Critical Thinking.

| # | Gap | Fix | Cost |
|---|---|---|---|
| G15 | **No failure story.** The plan only demos the happy path. | Three drills: stampede (50 buyers, 5 units), kill indexer → orders still succeed → restart → lag drains → drift 0, replay from offset 0 → index unchanged. | ~3 h |
| G16 | **"Retail operations" are named as a user (slide 2) but nothing is built for them.** | `/ops` doubles as the store-ops view: low-stock alerts from `notifier` (qty ≤ 2) + event feed. | ~1 h (shared with G4) |
| G17 | **"Find it nearby" (the tagline) isn't implemented** beyond a city filter. | Out-of-stock card says **"Not in Bengaluru · 3 left in Mumbai"**: one `terms` query over the product×city docs. Our "own flair" (R3). | ~45 min |
| G18 | **"Fast" is claimed but never measured.** | Show OpenSearch `took` ms on results; the stampede prints checkout p50/p95. | ~30 min |
| G19 | **Live stock isn't visible.** The slide shows a rejection but not search updating. | Cards poll the OpenSearch index every 1.5 s and flip ("1 left" → "Out of stock") when the indexer applies the Kafka event, within ~2 s. | ~1.5 h |
| G20 | Slide 6 says "**fewer** oversold orders". | Say **"zero oversold orders, and we'll prove it"**. | 0 |

## 5. Disclosure 🔴

| # | Gap | Fix |
|---|---|---|
| G23 | **Disclosure** of third-party libs, APIs and AI tools (rule 7). | "Disclosure" section in root `README.md`, kept up to date. |

## 6. Deliberately out of scope (say so if asked)

Login/auth, payments, real email/SMS delivery, admin product editing, cart reservations/holds with TTL, multi-region, Kafka Connect/CDC (outbox chosen instead, ADR-2), recommendations. Each is a "next step" answer, not a build item.

## 7. Updates needed in the final pitch deck (vs the submission)

1. Architecture slide: add the **notifier** consumer next to the indexer ("one event, independent reactors") and show the Vercel / worker-host split.
2. Replace "fewer oversold orders" with "**zero** oversold orders".
3. Add one line: "Allocation is synchronous in PostgreSQL; Kafka carries facts, never decisions."
4. Add a **"We broke it on purpose"** slide: stampede numbers, kill/restart, replay.
5. Add the deployment-constraint story: the Vercel API never touches Kafka (the outbox makes that possible), the worker host can die and checkout keeps working. This shows critical thinking.
