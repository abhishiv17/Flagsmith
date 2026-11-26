# 20 · Returns: plan

A shopper returns something they bought, with proper checks, and every Aiven service we run does a visible job on the way. Nothing here is a new service.

## The journey (what the demo shows)

1. **Order page → "Return an item".** Pick the item and quantity, choose a reason (defective, wrong item, not as described, changed my mind) and confirm its condition (sealed / opened / used).
2. **Instant eligibility check.** Either "Eligible: refund ₹1,299 to your original payment", or a clear reason it isn't ("The 7-day window closed on 28 Nov", "Earbuds can be returned only if sealed or defective").
3. **Request accepted → drop-off.** Bring it to the StockHop store in your city (or the partner shop that sold it). A return code is shown.
4. **Store inspects it** (Store console → Returns queue). Accept → refund + back on the shelf; or reject with a reason.
5. **Refund** through Razorpay (Test Mode) to the original payment, once. **Stock +1**: search shows it in stock within seconds, and anyone waiting for "Notify me when it's back" is told.
6. **The retailer sees why things come back**: return rate and reasons per product (ClickHouse), live in the Store console and Dashboards.

## The checks (all server-side, in one PostgreSQL transaction)

| # | Check | Rule | Message when it fails |
|---|---|---|---|
| 1 | **Owner** | Signed in as the order's verified email (doc/17), or a sign-in code sent to that email for guests | "Sign in with the email you ordered with." |
| 2 | **Order state** | `confirmed` and paid (a captured Razorpay payment) | "This order wasn't completed, so there's nothing to return." |
| 3 | **Window** | Within 7 days of purchase (10 for defective) | "The return window closed on 28 Nov." |
| 4 | **Quantity** | Bought − already returned or in a return ≥ requested; the order line is **row-locked**, so two tabs can't return the same unit twice | "You've already returned this item." |
| 5 | **Category policy** | Per category: hygiene items (earbuds, earphones, sleep kit) only if sealed or defective; final-sale items never | "Earbuds can be returned only if sealed or defective." |
| 6 | **Condition vs reason** | "Changed my mind" needs sealed; defective can be opened | "Opened items can be returned if they're faulty." |
| 7 | **Abuse guard** | More than 3 returns in 30 days → goes to manual review instead of auto-approve (read from ClickHouse) | "We'll review this one and reply within a day." |
| 8 | **Inspection** | Store confirms condition. Mismatch → partial refund or rejection, with a reason | shown on the order page |
| 9 | **Refund once** | Refund stored with the Razorpay refund id; retries return the same refund (idempotency key) | n/a |

A coupon order refunds what was actually paid for that line (discount pro-rated). A partner-shop order (doc/13) is returned to and refunded by that shop, and its stock goes back to the shop.

## How each Aiven service shows up

| Service | Role in returns | Visible where |
|---|---|---|
| **PostgreSQL** | `returns` + `return_items` tables; all checks and state changes in one transaction with row locks; the state machine `requested → approved → received → refunded / rejected`; stock back via `changeStock` (reason `return`) and the outbox | Order page timeline; Store console queue |
| **Kafka** | New topic `returns.events` (ReturnRequested, ReturnApproved, ReturnReceived, RefundIssued) from the outbox; `inventory.changed` for the restock | `/ops` pipeline tiles; consumer lag |
| **OpenSearch** | Restocked item flips to in stock in search within seconds (existing indexer); **Dashboards** panel "Returns by reason / product" | Search results; Dashboards |
| **Valkey** | Live stock cache updated by the indexer's write-through, so cards show the unit back at once; a short rate limit on return requests per account | "● Live · checked N s ago" on cards |
| **ClickHouse** | New consumer of `returns.events`: return rate and top reasons per product and city; repeat-returner signal for check 7 | Store console → "Why things come back" |
| **Notifier (Kafka consumer)** | Simulated emails: request received, approved, refunded; and **back-in-stock alerts** fire for the returned unit | Account page alerts; order page |

## Build steps

| Step | What | Size |
|---|---|---|
| R1 | Migration 012: `returns`, `return_items` (FK to order line, qty, reason, condition, status, refund ids), indexes; policy table per category | S |
| R2 | `server/domain/returns.ts`: `checkEligibility()` (checks 1–7, read-only, for the instant answer) and `requestReturn()` (same checks under row locks, writes return + outbox event) | M |
| R3 | Store side: `approve`, `receive` (inspection: condition, partial/full), `reject`; on receive → `changeStock(+qty, 'return')` or partner stock; on approve+receive → refund | M |
| R4 | Razorpay Test Mode refund (`POST /payments/{id}/refund`), idempotent, stored on the return; failures leave the return `received` with a retry | S |
| R5 | Events: `returns.events` topic (kafka:topics), notifier messages, ClickHouse table + "Why things come back" query, Dashboards panel | M |
| R6 | UI: "Return an item" on the order page (eligibility shown live), return timeline; Store console "Returns" queue with inspect / approve / reject; account page lists returns | M |
| R7 | `npm run returns:test`: window expired, non-returnable, over-quantity, **two tabs returning the last unit at once (one wins)**, wrong account, double refund refused, restock exactly once, back-in-stock alert fires, partner-shop return goes to the shop | M |
| R8 | doc/20 results, demo script, redeploy web + workers | S |

## Demo script (2 minutes)

Buy Pocket Speaker → order page → **Return** → "changed my mind, sealed" → eligible → Store console: receive, sealed → **refund issued** (Razorpay test refund id) → the search card flips to in stock → the other laptop, which had pressed "Notify me", gets the alert → Dashboards / Store console: "Why things come back" shows the reason.

Then the checks: try returning the same speaker again → "already returned". Try returning earbuds opened, "changed my mind" → refused with the hygiene rule.
