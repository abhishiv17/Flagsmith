# 14: Shopper analytics (clickstream through Kafka and OpenSearch)

StockHop records what shoppers do (screens viewed, buttons clicked, searches, being told "sold out") and charts it live on `/ops`. It reuses the pipeline we already trust: the browser never talks to Kafka, and neither does the Vercel API.

```
browser (web/src/track.ts)
  batches every 10 s, sendBeacon when the tab closes
  ─► POST /api/track            one INSERT … SELECT FROM jsonb_array_elements: N outbox rows, topic user.activity
  ─► relay ─► Kafka user.activity (2 partitions, key = hashed visitor)
  ─► analytics worker            also reads orders.placed + inventory.changed
  ─► OpenSearch stockhop-activity   one doc per event, _id = outbox event id (replays overwrite, never double-count)
  ─► GET /api/ops/analytics      aggregations ─► /ops "Shopper analytics" panel, or OpenSearch Dashboards
```

## What is recorded

| Event | When | Fields |
|---|---|---|
| `page_view` | every screen change | path, city |
| `click` | any button or link | its visible label (prices and long numbers removed), product id for product links |
| `search` | a search returns | query, result count (so we see searches with **no results**) |
| `sold_out_seen` | the API answers `OUT_OF_STOCK` | path |
| `api_error` | any other API error | error code |
| `order_placed` | from Kafka `orders.placed` | city, total, item count (no name or email) |
| `stock_changed` | from Kafka `inventory.changed` | product, city, qty, delta, reason, `sold_out` |

**Privacy.** No names, emails, phone numbers or anything typed into a form. Clicks inside inputs and `[data-no-track]` are ignored, and the server scrubs anything that looks like an email or phone number. The session cookie is the cart key, so it is never stored: only `sha256("stockhop:" + sid)` cut to 16 hex characters, enough to count distinct visitors.

**Load.** One batch insert per browser every 10 s at most. If the API answers `503 BUSY` (PostgreSQL connections full), the tracker keeps its queue and pauses for 60 s: shopping traffic comes first. `/ops` is never tracked.

## What `/ops` shows

Visitors and events · orders and revenue by city · **"Lost the race"**: visitors who were told sold out, and how many items sold out · events per minute for the last hour, with orders marked · funnel (visitors → searched → viewed a product → reached checkout) · most-clicked buttons · top searches · **searches with no results** (catalogue gaps) · most-viewed products · screens.

## Running it

```bash
npm run kafka:topics          # creates user.activity (4 of the free tier's 5 topics)
npm run workers               # relay + indexer + notifier + monitor + analytics
```

The analytics worker creates the `stockhop-activity` index on start and backfills every order and stock change still in Kafka. For ad-hoc charts, open OpenSearch Dashboards on the Aiven service and add an index pattern `stockhop-activity` with time field `at`.

Config: `TOPIC_ACTIVITY` (default `user.activity`), `OPENSEARCH_ACTIVITY_INDEX` (default `stockhop-activity`). Code: `web/src/track.ts`, `server/routes/track.ts`, `server/domain/activity.ts`, `server/workers/analytics.ts`, `server/routes/analytics.ts`, `web/src/components/AnalyticsPanel.tsx`.
