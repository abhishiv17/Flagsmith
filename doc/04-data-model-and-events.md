# 04: Data Model, Search Index & Events

## 1. PostgreSQL schema (`server/src/db/migrations/001_init.sql`)

```sql
CREATE TABLE cities (
  code  text PRIMARY KEY,                 -- 'BLR' | 'MUM' | 'DEL'
  name  text NOT NULL
);

CREATE TABLE products (
  id           serial PRIMARY KEY,
  sku          text UNIQUE NOT NULL,
  name         text NOT NULL,
  brand        text NOT NULL,
  category     text NOT NULL,             -- slug: audio | wearables | mobile-accessories | home-kitchen | bags-travel
  description  text NOT NULL DEFAULT '',
  tags         text[] NOT NULL DEFAULT '{}', -- search helpers: {'bluetooth','earphones','tws'}
  price_paise  integer NOT NULL CHECK (price_paise > 0),
  image_key    text NOT NULL,             -- which illustration to render
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE inventory (
  product_id  integer NOT NULL REFERENCES products(id),
  city_code   text    NOT NULL REFERENCES cities(code),
  qty         integer NOT NULL CHECK (qty >= 0),     -- I-3 backstop
  version     bigint  NOT NULL DEFAULT 1,            -- I-4, drives OpenSearch external version
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, city_code)
);

CREATE TABLE customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  email       text UNIQUE NOT NULL,
  phone       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE carts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  text NOT NULL,              -- from httpOnly cookie sh_sid
  city_code   text NOT NULL REFERENCES cities(code),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','checked_out')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- one active cart per session per city (G10)
CREATE UNIQUE INDEX carts_one_active ON carts (session_id, city_code) WHERE status = 'active';

CREATE TABLE cart_items (
  cart_id     uuid    NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id  integer NOT NULL REFERENCES products(id),
  qty         integer NOT NULL CHECK (qty BETWEEN 1 AND 10),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no         bigserial UNIQUE,      -- shown as SH-BLR-1042
  customer_id      uuid NOT NULL REFERENCES customers(id),
  city_code        text NOT NULL REFERENCES cities(code),
  status           text NOT NULL DEFAULT 'confirmed',
  total_paise      integer NOT NULL,
  idempotency_key  text UNIQUE NOT NULL,  -- G12
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id          uuid    NOT NULL REFERENCES orders(id),
  product_id        integer NOT NULL REFERENCES products(id),
  qty               integer NOT NULL CHECK (qty > 0),
  unit_price_paise  integer NOT NULL,     -- price snapshot (G11)
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,    -- doubles as event_id (monotonic, unique)
  topic         text  NOT NULL,
  msg_key       text  NOT NULL,
  event_type    text  NOT NULL,           -- 'OrderPlaced' | 'InventoryChanged'
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

-- written ONLY by the notifier consumer
CREATE TABLE notifications (
  id          bigserial PRIMARY KEY,
  event_id    bigint UNIQUE NOT NULL,     -- I-6 idempotency
  order_id    uuid NOT NULL REFERENCES orders(id),
  channel     text NOT NULL DEFAULT 'email',
  recipient   text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stock_alerts (
  id          bigserial PRIMARY KEY,
  event_id    bigint UNIQUE NOT NULL,
  product_id  integer NOT NULL REFERENCES products(id),
  city_code   text NOT NULL REFERENCES cities(code),
  qty         integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

Notes:
- `gen_random_uuid()` is built into PostgreSQL 13+ (Aiven ships newer). No extension needed.
- The **only** function allowed to `UPDATE inventory` is `changeStock(tx, {productId, city, delta, reason, orderId?})` in `server/src/domain/stock.js`. It does the conditional update **and** inserts the `InventoryChanged` outbox row (I-1).

## 2. Kafka

### Topics (Developer tier: up to 20 topics; we use 3)

| Topic | Partitions | Key | Event types | Consumers (group ids) |
|---|---|---|---|---|
| `orders.placed` | 2 | `order_id` | `OrderPlaced` | `notifier` |
| `inventory.changed` | 2 | `${product_id}:${city_code}` | `InventoryChanged` | `search-indexer`, `notifier` |

| `smoke` | 1 | `smoke` | test pings | `npm run smoke` only |

**Create topics manually in the Aiven console.** Don't rely on auto-create.

The `pipeline_stats` table (written by the worker monitor, read by `/api/ops/summary`) is also in `001_init.sql`.

### Envelope (every message value, JSON)

```json
{
  "eventId": 1042,
  "eventType": "InventoryChanged",
  "schemaVersion": 1,
  "occurredAt": "2026-11-21T14:03:11.204Z",
  "payload": { }
}
```
Kafka headers: `event-type`, `event-id` (makes the `/ops` feed cheap to render).

### `InventoryChanged` payload

```json
{
  "productId": 1, "cityCode": "BLR",
  "qty": 0, "delta": -1, "version": 7,
  "reason": "order",             // order | restock | seed
  "orderId": "uuid-or-null",
  "doc": {                       // full search doc (ADR-4)
    "sku": "AUD-001", "name": "Everyday Buds", "brand": "Hop Audio",
    "category": "audio", "description": "Bluetooth 5.3 true wireless earbuds …",
    "tags": ["bluetooth","earphones","earbuds","tws","wireless"],
    "pricePaise": 129900, "imageKey": "buds", "cityName": "Bengaluru"
  }
}
```

### `OrderPlaced` payload

```json
{
  "orderId": "uuid", "orderNumber": "SH-BLR-1042", "cityCode": "BLR",
  "customer": { "name": "Asha", "email": "asha@example.com" },
  "items": [ { "productId": 1, "name": "Everyday Buds", "qty": 1, "unitPricePaise": 129900 } ],
  "totalPaise": 129900
}
```

Outbox ordering inside one checkout: all `InventoryChanged` rows first, then `OrderPlaced`.

## 3. OpenSearch

### Index (create as `products_v1`, alias `products`)

```json
PUT /products_v1
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 0,
    "analysis": {
      "filter": {
        "shop_synonyms": {
          "type": "synonym_graph",
          "synonyms": [
            "earphones, earbuds, headphones, tws, in-ear",
            "speaker, soundbox",
            "bottle, flask",
            "charger, adapter",
            "power bank, powerbank, portable charger",
            "backpack, bag, rucksack",
            "smartwatch, smart watch, watch",
            "cable, cord, wire"
          ]
        }
      },
      "analyzer": {
        "product_text":     { "tokenizer": "standard", "filter": ["lowercase", "asciifolding"] },
        "product_text_syn": { "tokenizer": "standard", "filter": ["lowercase", "asciifolding", "shop_synonyms"] }
      }
    }
  },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "product_id":    { "type": "integer" },
      "sku":           { "type": "keyword" },
      "name":          { "type": "text", "analyzer": "product_text",
                         "fields": { "kw": { "type": "keyword" },
                                     "sayt": { "type": "search_as_you_type" } } },
      "brand":         { "type": "text", "analyzer": "product_text", "fields": { "kw": { "type": "keyword" } } },
      "category":      { "type": "keyword" },
      "description":   { "type": "text", "analyzer": "product_text" },
      "tags":          { "type": "text", "analyzer": "product_text" },
      "price_paise":   { "type": "integer" },
      "image_key":     { "type": "keyword", "index": false },
      "city":          { "type": "keyword" },
      "city_name":     { "type": "keyword" },
      "qty":           { "type": "integer" },
      "in_stock":      { "type": "boolean" },
      "stock_version": { "type": "long" },
      "updated_at":    { "type": "date" }
    }
  }
}
POST /_aliases { "actions": [ { "add": { "index": "products_v1", "alias": "products" } } ] }
```

Doc id: `${product_id}_${city}` → 90 docs.

### Search query (the one in the demo)

`GET /api/search?q=bluetoth earphones&city=BLR&maxPrice=1500`

```json
{
  "size": 24,
  "query": {
    "bool": {
      "must": [{
        "bool": {
          "should": [
            { "multi_match": { "query": "bluetoth earphones",
                "fields": ["name^3", "tags^2", "brand^2", "description"],
                "analyzer": "product_text_syn", "boost": 2 } },
            { "multi_match": { "query": "bluetoth earphones",
                "fields": ["name^3", "tags^2", "brand^2", "description"],
                "analyzer": "product_text",
                "fuzziness": "AUTO", "prefix_length": 1 } }
          ],
          "minimum_should_match": 1
        }
      }],
      "filter": [
        { "term":  { "city": "BLR" } },
        { "range": { "price_paise": { "lte": 150000 } } }
      ]
    }
  },
  "sort": [ { "in_stock": "desc" }, "_score", { "price_paise": "asc" } ],
  "aggs": {
    "categories": { "terms": { "field": "category" } },
    "price_bands": { "range": { "field": "price_paise", "ranges": [
        { "key": "under-500",  "to": 50000 },
        { "key": "500-1500",   "from": 50000, "to": 150000 },
        { "key": "1500-3000",  "from": 150000, "to": 300000 },
        { "key": "3000-plus",  "from": 300000 } ] } }
  }
}
```

**Why two `should` clauses:** fuzziness and multi-word `synonym_graph` don't combine reliably in one clause. Clause 1 catches synonyms (earphones ↔ earbuds) exactly; clause 2 catches typos ("bluetoth" → bluetooth, 1 edit) without synonyms. Facet filters (`category`) go into `filter` so they don't affect scoring.

- No `q` → `match_all` in `must` (browse mode).
- Facet counts come from `aggs`. Note that aggs respect the current filters; fine for a hackathon.
- **Must test early:** run the demo queries in OpenSearch Dashboards (Aiven provides it) before wiring the UI. Test list: `bluetoth earphones`, `earbuds`, `headfones`, `powerbank`, `bottel`, `backpak`.

### "Also available nearby" (G17)

```json
{ "query": { "bool": { "filter": [
    { "term": { "product_id": 4 } },
    { "term": { "in_stock": true } } ],
  "must_not": [ { "term": { "city": "BLR" } } ] } } }
```
Batched for all out-of-stock results in one `terms` query on `product_id`.

## 4. Seed catalogue (30 products × 3 cities)

`scripts/seed.js` is **deterministic** (fixed values, no randomness), so every teammate and every demo reset gets the same state. It goes through `changeStock(reason='seed')` so the index is built via Kafka.

Mockup products (slide 3) are **bold** and must match exactly.

| SKU | Name | Category | ₹ | Tags | BLR | MUM | DEL |
|---|---|---|---|---|---|---|---|
| AUD-001 | **Everyday Buds** | audio | **1,299** | bluetooth earphones earbuds tws wireless | **1** | 4 | 0 |
| AUD-002 | **Pocket Speaker** | audio | **999** | bluetooth speaker portable | **6** | 9 | 5 |
| AUD-003 | Studio Over-Ear Headphones | audio | 3,499 | bluetooth headphones anc wireless | 0 | 3 | 2 |
| AUD-004 | Neckband Pro | audio | 1,099 | bluetooth earphones neckband wireless | 12 | 8 | 10 |
| AUD-005 | Bass Cube Speaker | audio | 2,199 | bluetooth speaker party | 4 | 0 | 6 |
| AUD-006 | Classic Wired Earphones | audio | 399 | wired earphones 3.5mm | 25 | 30 | 20 |
| AUD-007 | Kids Safe Headphones | audio | 1,499 | bluetooth headphones kids volume-limit | 2 | 5 | 0 |
| AUD-008 | Soundbar Mini | audio | 4,999 | soundbar tv speaker bluetooth | 3 | 2 | 4 |
| WRB-001 | Pulse Fitness Band | wearables | 1,799 | fitness band tracker heart-rate | 9 | 7 | 11 |
| WRB-002 | Orbit Smartwatch | wearables | 3,999 | smartwatch bluetooth calling | 5 | 6 | 3 |
| WRB-003 | Step Clip Tracker | wearables | 699 | pedometer tracker | 14 | 0 | 8 |
| WRB-004 | Halo Smart Ring | wearables | 4,499 | smart ring sleep tracker | 1 | 2 | 2 |
| MOB-001 | 20W Fast Charger | mobile-accessories | 799 | charger usb-c fast adapter | 20 | 18 | 22 |
| MOB-002 | Braided USB-C Cable | mobile-accessories | 349 | cable usb-c braided | 40 | 35 | 30 |
| MOB-003 | 10000mAh Power Bank | mobile-accessories | 1,199 | power bank portable charger | 7 | 0 | 9 |
| MOB-004 | MagGrip Phone Stand | mobile-accessories | 299 | phone stand holder | 15 | 12 | 10 |
| MOB-005 | Car Charger Duo | mobile-accessories | 549 | car charger usb dual | 6 | 8 | 0 |
| MOB-006 | Wireless Charging Pad | mobile-accessories | 999 | wireless charger qi pad | 5 | 4 | 6 |
| HOM-001 | **Travel Bottle** | home-kitchen | **699** | bottle steel insulated flask | **8** | 10 | 7 |
| HOM-002 | Steel Lunch Box | home-kitchen | 549 | lunch box tiffin steel | 11 | 9 | 12 |
| HOM-003 | Insulated Coffee Mug | home-kitchen | 449 | mug coffee travel insulated | 10 | 0 | 6 |
| HOM-004 | LED Desk Lamp | home-kitchen | 1,299 | lamp led desk study | 4 | 6 | 5 |
| HOM-005 | Electric Kettle 1.5L | home-kitchen | 1,149 | kettle electric | 6 | 5 | 0 |
| HOM-006 | USB Mini Fan | home-kitchen | 399 | fan usb portable | 18 | 15 | 20 |
| BAG-001 | Commuter Backpack | bags-travel | 1,899 | backpack laptop bag office | 7 | 9 | 8 |
| BAG-002 | 14" Laptop Sleeve | bags-travel | 699 | laptop sleeve bag | 12 | 10 | 0 |
| BAG-003 | Travel Pouch Set | bags-travel | 499 | pouch organiser travel | 9 | 11 | 10 |
| BAG-004 | Weekender Duffel | bags-travel | 2,299 | duffel bag travel gym | 0 | 4 | 3 |
| BAG-005 | Compact Umbrella | bags-travel | 399 | umbrella rain compact | 22 | 30 | 15 |
| BAG-006 | Memory Foam Neck Pillow | bags-travel | 449 | neck pillow travel | 8 | 6 | 7 |

Demo-critical properties of this data:
- `bluetoth earphones` + BLR + ≤ ₹1,500 → **Everyday Buds (1 left)**, Neckband Pro, Kids Safe Headphones (via synonym). ✔ Slide 2.
- Everyday Buds BLR = 1 → the **two-window last-unit** demo; MUM = 4 → "Not in Bengaluru · 4 left in Mumbai" right after it sells out. ✔ G17.
- Studio Over-Ear Headphones BLR = 0, MUM = 3 → "also nearby" visible from the start.
- Low-stock alerts fire for qty ≤ 2 (Halo Ring, Kids Headphones…).
- Stampede is a "flash sale" on **Orbit Smartwatch** (`scripts/restock.js WRB-002 BLR 5`), so the slide-3 mockup products stay exactly as shown.

Brand names are our own placeholders ("Hop Audio", "Hop Home", …). **No real brand names or logos** (originality + no trademark issues). Images: flat SVG illustrations per `image_key` on coloured tiles, matching the deck mockup style.
