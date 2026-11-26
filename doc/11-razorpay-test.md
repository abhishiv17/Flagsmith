# Razorpay Test Mode backend check

> **Update:** checkout now takes a Razorpay Test payment with pending-payment holds, verification and release. See [13: Payments and the two-laptop demo](./13-payments-and-demo.md). The notes below describe the earlier connectivity checks.

The backend can create and retrieve **Razorpay Test Mode orders**. This is a gateway connectivity check, not a customer payment flow. It does not create a StockHop order, change inventory, charge anyone, or move test funds. Razorpay Test Mode has no balance to top up; its transactions are simulated.

## Configuration

Put `test_api_key=rzp_test_...` and `test_key_secret=...` in local `.env` or deployment secrets. The names match the current local `.env`. Keep `ADMIN_TOKEN` configured. The backend refuses a key without the `rzp_test_` prefix. Never put the secret in React, a URL, a curl command, logs, or Git.

## Check the integration

Start the backend with `npm run dev:api`. In PowerShell, enter your local admin token without committing it:

```powershell
$adminToken = Read-Host 'StockHop ADMIN_TOKEN'
curl.exe -sS -X POST http://localhost:4000/api/payments/test/orders `
  -H "x-admin-token: $adminToken" `
  -H 'Content-Type: application/json' `
  -d '{"amountPaise":100}'
```

The response should include `testMode: true`, a `gatewayOrderId` beginning with `order_`, `amountPaise: 100`, `amountPaidPaise: 0`, and `status: created`. `100` paise means ₹1. The returned `keyId` is the public test key; the secret is never returned. Do **not** interpret `created` as `paid`.

Fetch the order again (replace the ID):

```powershell
curl.exe -sS http://localhost:4000/api/payments/test/orders/order_EXAMPLE `
  -H "x-admin-token: $adminToken"
```

Both endpoints require `x-admin-token`. Order creation accepts ₹1–₹1,000 in paise and generates a unique receipt. The endpoint does not let a caller choose a live key or arbitrary gateway URL.

## Repeatable live test suite

Run `npm run payment:test` with the local `.env` configured. This starts the API on a temporary local port, calls the real Razorpay **Test Mode** order API, and closes the local server. It checks unauthenticated access, malformed IDs, invalid amounts, ₹1 and ₹1,000 boundaries, order lookup, and five concurrent order-creation requests. The five requests must return five distinct gateway IDs and receipts. It prints only non-secret test results and one example order ID.

The suite passed on 21 November 2026: 7 groups of checks passed, including five concurrent order creations. Every returned order had `amountPaidPaise: 0`. The suite creates **seven** test gateway orders per run and does not charge money or change StockHop inventory. Concurrency here tests the **gateway order-creation route**, not the eventual StockHop stock-reservation or payment-confirmation race.

## What this proves and what it does not

The Test Mode API returned a created ₹1 order with `amount_paid: 0`. This proves that the locally configured test credentials can authenticate and create a gateway order. **A server-side order API call cannot simulate a shopper completing UPI payment.** The payment step requires a test Checkout interaction, followed by server-side signature/status verification and payment webhooks. The existing StockHop checkout currently confirms an order and allocates stock immediately; it must be redesigned with pending-payment and reservation states before it can be connected to a gateway payment safely.

Payment success, failure, cancellation, duplicate webhooks, refunds, and two buyers paying for one reserved item are **not covered by the automated order-creation suite**. The standalone Checkout experiment below covers gateway-level success and failure only; StockHop payment verification, webhooks, and reservations remain unimplemented.

## One Razorpay order, five payment attempts

For a gateway-only test, create **one** Test Mode order through `POST /api/payments/test/orders`. Open `/razorpay-test.html?order=ORDER_ID&key=TEST_KEY_ID&amount=100` on the local Vite server (`http://127.0.0.1:5173`) in five tabs. This standalone page loads Razorpay Standard Checkout with the **same** order ID in every tab. It accepts only a `rzp_test_` key and runs only on localhost. The key ID is public; the secret is never sent to the browser. Choose the mock bank's Failure button for four attempts and Success for one. No real money moves.

Read `GET /api/payments/test/orders/ORDER_ID` and `GET /api/payments/test/orders/ORDER_ID/payments` with `x-admin-token` to see the order's `attempts`, `amountPaidPaise`, status, and each payment's status. The latter response omits customer contact and other payment details. Opening five Checkout windows is not itself five payments: each attempt must reach the mock bank. This test is **independent of StockHop inventory** and does not verify customer checkout, stock reservation, or webhooks.

**Observed gateway result, 21 November 2026:** five overlapping Checkout sessions for test order `order_U2lPfm2ONhshr1` reached the Razorpay mock bank. All five initial attempts were marked `failed`, leaving the order `attempted` with `amountPaidPaise: 0`. A sixth attempt against the **same order** selected Success and was marked `captured`; Razorpay then reported order status `paid`, `attempts: 6`, and `amountPaidPaise: 100` (₹1 simulated). A separate controlled order `order_U2lYXATF0r7sGm` had one successful attempt and was also `paid` with ₹1 simulated. These are observed gateway records, not real money or StockHop order confirmations. We did **not** observe five successful attempts racing for one order, so we do not claim a measured “one winner out of five successes” result.

## Separate five-shopper inventory race

Run `npm run checkout:race` after PostgreSQL is configured and the seed catalogue exists. It sets Everyday Buds in Bengaluru to one unit, creates five independent guest carts, submits five checkouts concurrently, then checks for **one HTTP 201, four HTTP 409 responses, exactly one new order, and zero stock remaining**. It restores the prior stock quantity in a `finally` block. This is a **PostgreSQL stock-allocation test**, not a Razorpay payment test. It leaves the one successful demo order in the database.

**Live result, 21 November 2026:** after the Aiven PostgreSQL CA certificate was supplied, the test passed. Shopper 2 received HTTP `201`; shoppers 1, 3, 4, and 5 received HTTP `409`. The script verified exactly one new order and quantity `0` immediately after the race, then restored the previous quantity in its cleanup. A separate database read confirmed the restored quantity was `1`. The five checkout requests completed in about 1.34 seconds as a group. This is one observed run, not a latency guarantee or a Razorpay payment result.

References: [Razorpay Create Order API](https://hdfcbank-collectnow-docs.razorpay.com/api/orders/create/), [Razorpay Test Mode integration](https://razorpay.com/docs/server-integration/python/test-app/), [Webhook validation](https://hdfcbank-collectnow-docs.razorpay.com/webhooks/validate-test/).
