# 16 · Customers dashboard on ClickHouse, loyalty coupons, prices across cities

For the retailer: **who buys the most, who keeps coming back to look, what they look at, and a
one-click personal coupon for that customer.** Plus: the same product's price range across Bengaluru,
Mumbai and Delhi, for shoppers and for the retailer.

Live at `/ops/customers` (Store console → Customers). It needs the store admin token, because it shows
customer names and emails.

## How the data gets there

```
checkout / payment confirm ──► PostgreSQL (order + outbox, one transaction)
browser track() ─► /api/track ─► outbox
                                   │ relay
                                   ▼
                     Kafka: orders.placed, user.activity
                                   │ clickhouse worker (own consumer group "clickhouse")
                                   ▼
             Aiven for ClickHouse: orders · order_lines · activity
                                   │ 4 aggregate queries (~100 ms)
                                   ▼
                     GET /api/retailer/customers  ──►  /ops/customers
```

- **Same events, new consumer.** The worker reads the Kafka topics the indexer, notifier and analytics
  workers already read, with its own consumer group, from the beginning of each topic. Adding
  ClickHouse didn't touch checkout's hot path.
- **Idempotent.** Tables are `ReplacingMergeTree` keyed by order id or event id and queried with
  `FINAL`, so Kafka redelivery or a re-run of the seed replaces rows instead of double-counting.
- **Who is who.** Clicks are recorded against a one-way visitor hash, never a name (doc/14). A
  visitor is linked to a customer only through **their own order**: `OrderPlaced` now carries the
  same hash (`visitor`). Browsing by people who never ordered stays anonymous.
- **Why ClickHouse and not OpenSearch.** OpenSearch keeps serving search and the live missed-demand
  panel. The customer view is joins and group-bys over every order line and click
  (spend per customer, views per customer across devices, buyers ÷ viewers per product). That is
  ClickHouse's job, and it answers all four queries in about 100 ms.

## Customer types (simple rules a shop owner can check by eye)

| Type | Rule | Suggested coupon |
|---|---|---|
| Top customer | top 10 % by spend, 2+ orders | 10 % thank-you |
| Gone quiet | 2+ orders, none in 14 days | 20 % win-back |
| Browses a lot | 12+ product views, at most 2 orders | 15 % nudge |
| New | one order | 10 % second-order |
| Regular | everyone else | 5 % |

"Most engaged" ranks by views + 3 × cart adds + searches.

## Coupons (PostgreSQL, migration 004)

- The retailer presses **Give coupon** and picks a discount (≤ 30 %, `COUPON_PERCENT_MAX`) and how long
  it lasts. The result is a code like `THANKS10-7K2QXM` plus a link that opens a product in a city (below).
- A code belongs to **one email**, works **once**, and **expires**. It covers our own store's items; it
  does not apply to partner-shop purchases.
- **Checkout** locks the coupon row (`SELECT … FOR UPDATE`) *before* any stock row, so it never makes
  the hot-row window longer (doc/12 F4). It writes `orders.discount_paise` and `coupon_code` and marks
  the coupon used **in the same statement** as the order. Two tabs spending one code therefore
  serialise, and the second gets "already used".
- Paying through Razorpay charges the discounted total. If the payment is cancelled or the hold
  expires, the coupon is freed again (`releaseCoupon` in `releaseOrder`).
- **The link opens a product in the customer's city.** Each coupon stores a target product and city
  (migration 005). By default these are the product the customer **looks at most** (else buys most) and
  the city they **order from most**, both taken from ClickHouse; the retailer can change them. Example:
  `/p/40?city=MUM&coupon=THANKS10-G6U474` opens Pulse Band Pro, switches the shop to Mumbai and shows a
  "10 % off your order" banner. The code is remembered in the browser, pre-filled at checkout, and
  applied as soon as the email is typed. The discount covers the whole order, not just that product.
  `GET /api/coupons/:code` (public) returns the offer, target product and city, and status, but **not the
  email**. Whose coupon it is gets checked at checkout.
- Discounts are rounded down to whole rupees.
- Wrong email, used, expired and unknown codes each get their own clear message (`409 COUPON_INVALID`).
  `POST /api/coupons/preview` checks a code before paying.
- `OrderPlaced` carries `discountPaise` and `couponCode`, so ClickHouse counts coupon orders and
  discount given.

Tested locally against the live databases: issue, then wrong-email preview (refused), preview,
checkout (₹349 → ₹315 after rounding the discount down to whole rupees; Razorpay order created for the discounted total), same-key replay (same order), reuse
(refused), cancel the hold (coupon free again).

## Prices across cities

- `npm run prices:seed`: every partner shop now offers **every product**, priced for its city: city
  level (Mumbai +6 %, Delhi −4 %), a per-product city swing (±7 %) and a shop markup (−3 % to +5 %).
  Deterministic. Existing partner stock counts are kept; only prices are reset. Result: 6 shops ×
  66 products, every product priced in all 3 cities.
- Our own store keeps **one chain-wide price** (`products.price_paise`), so carts, checkout and search
  are unchanged.
- `GET /api/products/:id/prices` (public) returns, per city, our price, stock, and the partner
  low/high. Shown on the product page as "Price across cities ₹X to ₹Y".
- `GET /api/retailer/price-spread` (admin) lists the products with the widest gap between cities.

## Demo history (seeded, labelled)

The live shop has only a handful of real test customers, so `npm run clickhouse:seed` writes 30
days of **fictional** history straight into ClickHouse with `source = 'demo'`:

- 40 shoppers on `example.com` in five behaviour types, 135 orders, 248 order lines and 3,050 events;
- 70 anonymous browsers.

It uses the real catalogue and prices. It is deterministic, and re-running it replaces the same rows
(`--reset` deletes them first). **Nothing is written to PostgreSQL**: stock, real orders and coupons
are untouched. The dashboard has an "Include demo history" toggle, and every demo row is marked
"demo". Real orders stream in alongside with `source = 'live'`.

## Endpoints

| Method | Path | Auth | What |
|---|---|---|---|
| GET | `/api/retailer/customers?days=30&demo=1` | admin | totals, customers + segments, daily revenue, product funnel, ClickHouse timing |
| GET | `/api/retailer/customers/:email` | admin | one customer's orders, top products bought and viewed, coupons |
| GET / POST | `/api/retailer/coupons` | admin | list / issue |
| GET | `/api/retailer/price-spread` | admin | widest city price gaps |
| GET | `/api/products/:id/prices` | public | price and stock per city |
| GET | `/api/coupons/:code` | public | a coupon link's offer, product, city and status (no email) |
| POST | `/api/coupons/preview` | shopper | would this code work for this email and cart? |

## Config

`CLICKHOUSE_URL` (Aiven ClickHouse **HTTPS** service URI with credentials; also read from
`CLICKHOUSE_HTTPS_URL` / `CLICKHOUSE_URI` if it is https) and `CLICKHOUSE_DATABASE` (default
`stockhop`; created on first use). Set it on both the web and workers apps. On Aiven App Runtime,
**Connect service** injects `CLICKHOUSE_HOST/PORT/USER/PASSWORD/SECURE` instead of one URI, and the URL is built
from those. Rename its database variable (we use `CLICKHOUSE_SERVICE_DB`) so it doesn't override
`CLICKHOUSE_DATABASE=stockhop` with `default`. The worker logs the host and port it uses, never the password. Without it, the worker
idles and the page says ClickHouse isn't connected; nothing else changes.

Connect service injects the **native** port (26527), not the HTTPS one. The client notices ClickHouse's
"use port 26528 for HTTP" reply, switches to that port and keeps it; `CLICKHOUSE_HTTPS_PORT` sets it outright.

Service: Aiven for ClickHouse, Developer plan, Europe (next to the app), from trial credits.

## Checking it end to end

`npm run e2e:retailer -- --base=https://<app>` (needs `ADMIN_TOKEN` in `.env`) checks the pages and
redirects, the clickhouse worker and its Kafka lag, the dashboard API, prices across cities and a coupon
link. It then places **one real order** (1 unit, 10 % coupon, fictional `example.com` customer) and waits
for that order, and a tracked click, to show up in ClickHouse.
