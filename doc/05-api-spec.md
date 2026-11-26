# 05: API Spec

Base: `http://localhost:4000/api` (Vite dev server proxies `/api` → avoids CORS).
All bodies JSON. Money is always integer **paise**. City is always a code: `BLR | MUM | DEL`.

**Session:** on the first request the API sets an httpOnly cookie `sh_sid` (random UUID, `SameSite=Lax`, 30 days). Carts hang off it. No login.

**Error shape (all non-2xx):**
```json
{ "error": { "code": "OUT_OF_STOCK", "message": "Human readable", "details": {} } }
```
Codes: `VALIDATION` (400), `NOT_FOUND` (404), `OUT_OF_STOCK` (409), `CART_EMPTY` (409), `SEARCH_UNAVAILABLE` (503), `INTERNAL` (500). Never leak stack traces or connection strings.

---

## Catalogue & search

### `GET /cities`
`200 [{ "code": "BLR", "name": "Bengaluru" }, …]`

### `GET /search`
Query: `q?`, `city` (required), `category?`, `minPrice?`, `maxPrice?` (paise), `inStock?` (`true`), `page?` (default 1), `size?` (default 24, max 48).
No `q` = browse mode.

```json
200 {
  "tookMs": 12,
  "total": 3,
  "items": [{
    "productId": 1, "sku": "AUD-001", "name": "Everyday Buds", "brand": "Hop Audio",
    "category": "audio", "pricePaise": 129900, "imageKey": "buds",
    "city": "BLR", "qty": 1, "inStock": true, "stockVersion": 7,
    "nearby": null                       // or { "city": "MUM", "cityName": "Mumbai", "qty": 4 } when out of stock here
  }],
  "facets": {
    "categories": [{ "key": "audio", "count": 3 }],
    "priceBands": [{ "key": "500-1500", "count": 3 }]
  }
}
```
`503 SEARCH_UNAVAILABLE` if OpenSearch is unreachable. The UI shows "Search is catching its breath, try again", and product pages still work.

### `GET /products/:id?city=BLR`
Served from **PostgreSQL** (authoritative).
```json
200 { "productId": 1, "sku": "AUD-001", "name": "...", "brand": "...", "category": "audio",
      "description": "...", "pricePaise": 129900, "imageKey": "buds",
      "stock": [ { "city": "BLR", "cityName": "Bengaluru", "qty": 1, "version": 7 },
                 { "city": "MUM", "cityName": "Mumbai",    "qty": 4, "version": 3 },
                 { "city": "DEL", "cityName": "Delhi",     "qty": 0, "version": 1 } ] }
```

---

## Cart (PG, per session + city)

### `GET /cart?city=BLR`
```json
200 { "cartId": "uuid", "city": "BLR",
      "items": [{ "productId": 1, "name": "Everyday Buds", "imageKey": "buds",
                  "qty": 2, "unitPricePaise": 129900, "available": 1, "shortBy": 1 }],
      "subtotalPaise": 259800,
      "otherCityCarts": [{ "city": "MUM", "itemCount": 2 }] }
```
`available` and `shortBy` are read live from PG on every call (G9). An empty cart returns `items: []`. The cart row is created lazily.

### `POST /cart/items`  `{ "city": "BLR", "productId": 1, "qty": 1 }`
Adds or increments (cap 10 per line). `200` = full cart (same shape as GET).
Adding beyond current stock is **allowed** but flagged with `shortBy`. Checkout decides.

### `PATCH /cart/items/:productId`  `{ "city": "BLR", "qty": 3 }`  → `200` cart
### `DELETE /cart/items/:productId?city=BLR` → `200` cart

---

## Checkout & orders

### `POST /checkout`
```json
{ "city": "BLR",
  "customer": { "name": "Asha R", "email": "asha@example.com", "phone": "9876543210" },
  "idempotencyKey": "uuid-generated-by-client-per-attempt" }
```
Validation: name 2–80 chars, email format, phone optional 10 digits, key = UUID.

| Result | Response |
|---|---|
| Success | `201 { "orderId": "uuid", "orderNumber": "SH-BLR-1042", "totalPaise": 129900 }` |
| Same key repeated | `200` with the **same** order (G12) |
| Any item short | `409 OUT_OF_STOCK`, `details.items: [{ productId, name, requested, available }]`. **Nothing** is written |
| Empty cart | `409 CART_EMPTY` |

The client keeps the same `idempotencyKey` across retries of the **same** attempt and generates a new one after a 409 or after the cart changes.

### `GET /orders/:orderId`
```json
200 { "orderId": "uuid", "orderNumber": "SH-BLR-1042", "city": "BLR", "status": "confirmed",
      "items": [...], "totalPaise": 129900, "createdAt": "...",
      "confirmationSent": true, "confirmationAt": "..." }   // from notifier's notifications table
```
The order page polls every 1 s (max 15 s) until `confirmationSent` is true.

---

## Live stock (polled from the search index, ADR-6)

### `GET /stock?city=BLR&ids=1,2,3`
One OpenSearch `mget` for docs `1_BLR, 2_BLR, …` (max 48 ids). Polled every 1.5 s by visible pages.
```json
200 { "items": [ { "productId": 1, "city": "BLR", "qty": 0, "inStock": false, "stockVersion": 8,
                   "nearby": { "city": "MUM", "cityName": "Mumbai", "qty": 4 } } ] }
```
Clients apply an item only if `stockVersion > current`. Response header `Cache-Control: no-store`.

---

## Ops (read-only, powers `/ops`)

### `GET /ops/summary`
```json
200 {
  "services": { "postgres": "up", "opensearch": "up" },
  "workers": [                                   // from pipeline_stats heartbeats; down if > 6 s old
    { "name": "relay", "up": true, "lastSeenMs": 800 },
    { "name": "indexer", "up": true, "lastSeenMs": 1200 },
    { "name": "notifier", "up": true, "lastSeenMs": 900 },
    { "name": "monitor", "up": true, "lastSeenMs": 700 }
  ],
  "outbox": { "pending": 0, "lastPublishedId": 1044 },
  "consumers": [                                 // from pipeline_stats, written by the monitor
    { "group": "search-indexer", "topic": "inventory.changed", "lag": 0 },
    { "group": "notifier",       "topic": "orders.placed",     "lag": 0 },
    { "group": "notifier",       "topic": "inventory.changed", "lag": 0 }
  ],
  "index": { "docs": 90, "inSync": 90, "drift": [] },   // PG inventory.version vs OS stock_version
  "recentEvents": [ { "id": 1044, "type": "OrderPlaced", "key": "…", "createdAt": "…", "publishedAt": "…" } ],
  "recentNotifications": [...], "stockAlerts": [...],
  "orders": { "total": 12, "lastMinute": 3 }
}
```
The Vercel API never connects to Kafka. Lag is computed on the worker host (`admin.fetchTopicOffsets` + `admin.fetchOffsets`) and stored in `pipeline_stats`. The event feed reads the latest outbox rows, showing when each was created vs published. `/ops` polls this endpoint every 2 s.

### `GET /health` → `200 { postgres, opensearch }` (each `up|down`; 503 if any is down). Kafka connectivity is checked by `npm run smoke` on the worker host.

---

## Admin (demo resets only)

Requires header `x-admin-token: $ADMIN_TOKEN`. Not linked from the UI.

### `POST /admin/restock` `{ "productId": 2, "city": "BLR", "qty": 5 }`
Sets absolute qty **through `changeStock`** (writes outbox, reason=`restock`), so I-1 holds even for resets.
