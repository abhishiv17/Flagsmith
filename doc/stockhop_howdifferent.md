# StockHop: how it works and why it is different

> **Pitch:** Out of stock should not mean out of options. StockHop finds the next *purchasable* option across a retailer's branches, then makes sure the promised stock can actually be ordered.

This is a proposed product direction and technical explanation, **not a claim that the feature has been implemented**. The current [concept proposal](./submission%20-Rangers.pdf) and [architecture](./03-architecture.md) model stock by **city**. Showing individual branches, ranking substitutes, and capturing unmet demand require the extensions described below. The required baseline remains browsing, search, cart, order, and real use of Aiven PostgreSQL, Kafka, and OpenSearch.

## 1. The shopper's experience

1. Choose a city and search for an item, even with a typo such as `bluetoth earphones`.
2. See matches, prices, and availability. If the preferred item is unavailable at the selected branch, see the **same item at another branch** first.
3. If no branch has it, see **comparable items** within the shopper's price range, with the branch and availability made clear.
4. If nothing suitable is available, choose **Notify me**. That request also becomes an unmet-demand signal for the retailer.
5. Add an available option to the cart and check out. If the last unit sold meanwhile, receive a clear stockout response and refreshed alternatives.

“Other stores” here means **branches of the participating retail chain**. Independent sellers would require separate catalogue, stock, pricing, and order integrations and are outside this proposal.

## 2. What each component does

| Component | Plain-language role | Why this use case needs it |
|---|---|---|
| **Aiven** | The managed platform hosting the required PostgreSQL, Kafka, and OpenSearch services. | The team can concentrate on the application and its data flow instead of operating these services. Aiven is the host, not an additional search algorithm or database. |
| **PostgreSQL** | The authoritative record of products, prices, branch stock, carts, customers, orders, and outbox events. | Checkout needs a transaction that can allocate the final unit once, even when requests arrive together. |
| **OpenSearch** | A search-optimized copy of product and availability data. | It can combine text relevance, typo tolerance, category and price filters, city/branch availability, and ranked alternatives without scanning the transactional tables for every search. |
| **Apache Kafka** | An ordered event stream that distributes facts such as `OrderPlaced` and `InventoryChanged` to independent consumers. | Search indexing, notifications, and operations views can react to a purchase without being coupled to the checkout request. |
| **API/backend** | Accepts browser requests, queries OpenSearch for discovery, and uses PostgreSQL for carts and checkout. | Keeps credentials and business rules off the browser. |
| **Frontend** | Search, alternatives, cart, checkout, and order status screens. | Makes the recovery path understandable to the shopper and visible in the demo. |

**Mental model:** PostgreSQL **decides** whether the sale can happen. Kafka **announces** committed changes. OpenSearch **helps find** options. A search result is a useful availability hint; it is not a reservation.

## 3. Search and alternatives: the internal workflow

```text
Shopper: "bluetoth earphones", Bengaluru, budget ₹1,500
    ↓
Browser → API → OpenSearch
    ↓
Text matching + typo tolerance + category/price/city filters
    ↓
Exact product available locally? Show it.
Otherwise: same SKU at another branch/city?
Otherwise: rank comparable products that are in stock and within budget.
Otherwise: offer Notify me and record unmet demand.
```

The API **does not run a full product search against PostgreSQL for every keystroke**. It queries OpenSearch's indexed product documents. PostgreSQL supplies the original product and inventory data; inventory events keep the index updated. The product detail page or checkout can read PostgreSQL when authoritative data is needed.

### A practical ranking algorithm

This can be deterministic and explainable; it does not require an AI model.

1. **Candidate generation:** use OpenSearch text matching on name, description, category, brand, and tags. Apply city/branch and maximum-price filters. Use a fuzzy clause for spelling errors and a separate synonym clause for terms such as `earphones` and `earbuds`, as planned in [the search design](./04-data-model-and-events.md#3-opensearch).
2. **Same-item rescue:** if the requested SKU is unavailable locally, look for that SKU at other branches. Rank branches with available stock before unavailable ones. If distance data exists, use distance or travel time as a tie-breaker; otherwise show the actual city/branch without claiming it is nearby.
3. **Substitutes:** only compare products in a compatible category and price band. Rank by text relevance, matching attributes, price difference from the requested item, and available quantity. Require a minimum relevance threshold so an unrelated cheap item is never presented as a good substitute.
4. **Explain the result:** label each card `Same item at another branch` or `Similar option under ₹1,500`, with the branch and price. Show the reason rather than an opaque “recommended” badge.

An illustrative score for substitute candidates is `0.50 × text relevance + 0.25 × attribute match + 0.15 × price closeness + 0.10 × branch convenience`. Those weights are **starting hypotheses**, not proven optimal values. Test them with a small catalogue and real example queries. Hard rules such as `in stock`, compatible category, and budget should be filters, not merely weak score bonuses.

**Data-model extension:** the present design has one inventory row and search document per `product × city`. Branch-level rescue needs `stores(id, city, location...)` and inventory per `product × store`, plus corresponding OpenSearch documents or branch availability fields. City availability can then be derived from branch stock. The API must say which branch can fulfill an order; the existing city-only model cannot truthfully do that.

## 4. Checkout and concurrent requests

Two shoppers may see `1 left` at the same time. Both may add it to a cart. **Only checkout allocates it.** The API uses a PostgreSQL transaction and a conditional stock update, conceptually:

```sql
UPDATE inventory
SET qty = qty - :requested, version = version + 1
WHERE product_id = :product_id
  AND store_id = :store_id
  AND qty >= :requested
RETURNING qty, version;
```

For the currently documented city-only version, replace `store_id` with `city_code`. PostgreSQL locks the affected stock row during the update. The second buyer waits, then checks the newly committed quantity. If the update returns no row, checkout rolls back and returns `OUT_OF_STOCK` with refreshed options. An order is saved only when **all** its items can be allocated. A `CHECK (qty >= 0)` constraint adds a backstop. An idempotency key makes a retried checkout return the same order instead of creating another one.

This is why the Kafka consumer **must not deduct stock after an order is accepted**. That would allow two orders to succeed before an asynchronous consumer runs. The PostgreSQL transaction makes the decision; Kafka distributes the resulting fact.

### Will the row lock make checkout slow?

The wait is **per stock row**, not a lock on the whole catalogue. Shoppers searching, browsing, and adding to carts do not wait on it. Buyers of different products or different stores can update different rows concurrently. Buyers of the **same product at the same store** must be serialized at the final allocation point; that is precisely how we avoid selling the same unit twice. A database index/primary key on `(product_id, store_id)` (or the current `(product_id, city_code)`) lets PostgreSQL find that row directly.

We keep that transaction short: calculate search recommendations **outside** it, do not call OpenSearch/Kafka/email/payment-like external services while holding the stock row, update stock and save the order/outbox rows, then commit. The row is locked only until commit. The API uses a bounded database connection pool so a traffic burst does not open one database connection per shopper. An idempotency key makes client retries safe. A sensible request/lock timeout should return a retryable busy response rather than let a request hang indefinitely; choose and test the timeout instead of assuming a fixed latency.

For a flash sale where thousands of buyers target one SKU, a single row is a **hotspot**. The conditional update remains correct, but the queue and tail latency can grow. We should be honest about that trade-off. Later scale options include a waiting room or admission control, splitting allocatable stock into carefully managed buckets, or assigning different stores' inventory independently. These add complexity and should be justified by measurements, not claimed as part of the basic demo. Kafka does **not** remove the checkout hotspot: putting the stock decision on an asynchronous consumer would make the shopper wait for a result or risk accepting invalid orders.

Measure this instead of promising “instant” checkout: run concurrent requests for (a) many different products and (b) one hot product with 5 units. Record success count, stock left, errors, and median/p95/p99 checkout latency. The correctness target for 50 one-unit requests against 5 units is **exactly 5 successful allocations** if all requests reach the checkout logic successfully; any transport errors must be reported separately. Compare the latency distributions to show where contention actually costs time.

## 5. How changes reach search

```text
Checkout transaction in PostgreSQL:
  decrement stock + save order + save outbox event → COMMIT
                                      ↓
                         outbox relay → Kafka
                                      ↓
           search indexer / notification / operations consumers
                                      ↓
                      OpenSearch shows updated availability
```

The **outbox** is a PostgreSQL table of events to publish. Saving it in the same transaction as the order avoids a dangerous gap: an order could commit and the app could crash before publishing its Kafka message. The relay retries unpublished events. Because retries can produce duplicates, consumers must be **idempotent**: processing the same event twice has the same final effect as processing it once.

Search updates are **eventually consistent**. A listing might briefly show an item that has just sold. That is acceptable only because checkout always rechecks PostgreSQL. Versioning prevents an older inventory event from overwriting a newer search document. The [existing architecture](./03-architecture.md) specifies these outbox, idempotency, and version rules for the city-level baseline.

## 6. Where the differentiation really is

| Standard online-store behavior | StockHop's proposed behavior |
|---|---|
| “Out of stock; notify me later.” | First search the chain for the **same item elsewhere**, then offer relevant, purchasable substitutes within budget. |
| Generic “you may also like” cards | Explain **why** each option solves the shopper's request: same SKU, compatible attributes, price, and fulfillment branch. |
| A product page showing a possibly old stock count | Treat search stock as a hint and prove the final allocation with transactional checkout. |
| Lost searches disappear | With a proposed demand-request feature, aggregate unavailable-item requests by city for an operations decision. |

The value is **out-of-stock recovery tied to trustworthy fulfillment**. Kafka, PostgreSQL, and OpenSearch are useful here because their roles match three different problems: correct allocation, distributing changes, and fast discovery. The architecture alone is not the differentiator; the customer recovery flow is.

## 7. What to demonstrate and test

| Test | Expected evidence |
|---|---|
| Typo search with city and price filters | OpenSearch returns relevant products for `bluetoth earphones`, Bengaluru, ≤ ₹1,500. |
| Same-item branch rescue | An unavailable local SKU shows an available branch, with truthful fulfillment details. Requires the branch-level extension. |
| Substitute quality | Suitable products stay in category and budget; unrelated products are excluded. Check several hand-picked queries. |
| Two buyers, one unit | Exactly one order succeeds; the other gets a stockout response; quantity never becomes negative. |
| Many buyers, limited stock | With 5 units and 50 concurrent one-unit checkouts, at most 5 succeed and final stock is 0. |
| Stale search result | Even if OpenSearch still says `1 left`, checkout rejects the sold-out item and refreshes alternatives. |
| Event delivery and replay | Show order/outbox → Kafka → indexer → changed search result; duplicate or older events do not corrupt stock or index state. |
| Indexer interruption | Checkout still works while indexing is paused; the consumer catches up after restart. |
| Duplicate checkout request | Same idempotency key returns the original order, without a second allocation. |

The first, checkout, event, and search demonstrations satisfy the brief. Branch rescue and substitute quality are the proposed distinguishing features. Do not describe a test as passed until it has been run against the working app.

## 8. Pitch and mentor checkpoint

> “Out of stock should not mean out of options. StockHop first finds the same item elsewhere in the retailer's network, then offers a comparable product within your budget that you can actually buy. OpenSearch finds the options, PostgreSQL guarantees the last unit goes to only one buyer, and Kafka keeps availability and operations in sync after each committed sale. If no option exists, we capture that missed demand so the retailer knows where stock is needed.”

Ask the mentor: **“Would a working same-item branch rescue plus explainable substitutes be a meaningful differentiator, and should we prioritize that over a retailer demand dashboard?”** This keeps the extension focused enough to build and verify.

## 9. Scope and honesty notes

- The current repo documents a **city-level concept**; branch-level inventory and alternative ranking are **proposals** until built.
- `Notify me` requires a consented contact method and a notification workflow. If only stored locally for the demo, call it a simulated notification, not a delivered message.
- Cross-branch transfer, pickup promises, travel-time estimates, and independent-store aggregation require additional operational data and should not be claimed without implementation.
- Aiven service availability, limits, and pricing should be checked in its current documentation before provisioning; the original brief's access information is a starting point, not a permanent guarantee.
