# 17 · Shopper accounts (optional sign-in)

**Guests can still do everything.** Browsing, racing for the last unit, partner rescue and Razorpay payment all work without an account. An account adds four things, each tied to what StockHop is about:

| | Why it matters for StockHop |
|---|---|
| **Fair last units** | Cart claims belonged to a browser, so three incognito windows could hold the last unit three times. Signed in, the cart belongs to the account: a second device trying to add the same last unit is told *"You already have the last … in your cart"* instead of claiming another |
| **Same cart on every device** | Start on the phone, pay on the laptop. Signing in brings the guest cart (and a payment in progress) along |
| **Your orders** | `/account` lists every order placed with that email, from any device, including ones placed as a guest before signing up |
| **Coupons only the owner can use** | Loyalty coupons ([16](./16-customers-clickhouse.md)) belong to one email. Before, knowing someone's email and code was enough. Now redeeming needs a sign-in with that email (`COUPON_REQUIRES_SIGN_IN`, default on) |

There's no separate auth provider: Aiven doesn't offer end-user auth, so accounts live in our Aiven PostgreSQL next to orders.

## Notify me when it's back

Where something is out for you (sold out, or the last unit is in someone's cart), the product page and the "out of stock for you" popup offer **🔔 Notify me when it's back in <city>**. Guests are sent to sign in first and come straight back. Alerts show on `/account`: *Waiting*, then *Back in Bengaluru · 3 left now* with **Buy now**, and a green dot appears on the account button in the header (refreshed every 20 s).

- `back_in_stock_alerts` (migration 007, applied): one open alert per shopper, product and city.
- **Primary path:** the notifier (Kafka consumer of `inventory.changed`) marks waiting alerts for that product and city when its stock goes above 0, whatever the reason (restock, a released payment hold…). Only rows not yet notified are touched, so a redelivered or replayed event tells nobody twice. Email is simulated, like confirmations (a log line).
- **Catch-up on read:** if the notifier was down or running older code when stock came back, reading the alerts marks any alert whose stock is above 0 and changed after the alert was set.
- Measured through the real pipeline: restock → outbox → Kafka → notifier → alert marked in **2.1 s**.

> **Deploy note:** the cloud notifier on Aiven Runtime runs the old code until `workers` is redeployed. Until then a back-in-stock event handled there is picked up by the catch-up instead. A laptop running `npm run dev` also starts workers in the **same consumer groups**, splitting partitions with the cloud; use `npm run dev:app` (API + web only) as doc/07 asks.

## How it works

- **Passwordless.** `POST /api/auth/code {email}` → 6-digit code; `POST /api/auth/verify {email, code, name?}` → signed in. `GET /api/auth/me`, `POST /api/auth/logout`, `GET /api/me/orders`.
- **An account is a customer with a verified email** (`customers.email_verified_at`). Orders already link to customers by email, so "my orders" needs no new link and the ClickHouse customers dashboard is unchanged.
- **Codes:** only a hash is stored (HMAC with `AUTH_SECRET` if set). Valid 10 minutes, used once, 5 wrong tries kill the code. With real email (`AUTH_DEMO_CODES=false`) they are rate-limited: one code per email per 30 s, 5 per hour; 30 per network per hour (the network is stored as a hash, never the address). In demo mode the code is shown on screen and nothing is sent, so there are no limits: demo logins can sign in as often as needed.
- **Sessions:** random 256-bit token in an `httpOnly`, `SameSite=Lax` cookie (`sh_auth`, `Secure` on HTTPS), 30 days; only its SHA-256 is stored (`account_sessions`). Sign-out deletes it.
- **Whose cart:** `shopperKey(req)` is `acct:<customer id>` when signed in, otherwise the guest cookie. Carts, cart claims, payment holds and analytics all use it, so the existing ownership checks (only you can verify or cancel your payment) work unchanged.
- **On sign-in** the guest carts merge into the account's (same product: the larger quantity, never the sum, so signing in can't claim extra units), and a pending payment moves with them.
- **Checkout while signed in** always uses the account's verified email, whatever the form says.
- **Analytics** ([14](./14-analytics.md)): a signed-in shopper's events carry a hash of the account key, so one person's journey is one visitor across devices. Still no names or emails.

### Email delivery is simulated

Like order confirmations, sign-in emails aren't really sent in this build. With `AUTH_DEMO_CODES=true` (default) the code is shown on the sign-in screen, labelled *"Demo mode: email is simulated in this build"*. To go live: plug a sender into `requestCode()` in `server/domain/accounts.ts` and set `AUTH_DEMO_CODES=false`.

## Tests

`npm run accounts:test` (real database, own server). Passed:

- wrong code → 401 "4 tries left"; right code → cookie, `/auth/me`; **guest cart adopted**
- used code refused; second code within 30 s → 429; **5 wrong tries kill a code** (right code then refused)
- **same account on a 2nd laptop sees the same cart; adding the last unit again → 409 `already_yours`**; a guest elsewhere still gets `in_someone_cart`
- coupon without sign-in → 401 `SIGN_IN_REQUIRED`; signed-in checkout with a different typed email → **order goes to the verified email**
- order listed in `/me/orders`; sign-out → `/auth/me` null, `/me/orders` 401
- alerts: guests refused (`SIGN_IN_REQUIRED`); one open alert per product+city; qty 0 tells nobody; stock back tells the shopper once; a replayed event tells nobody again

`npm run payment:race` still passes. In Chrome: sign-in with the on-screen code, header initial, `/account`, checkout pre-filled with the email locked, sign-out. No console errors.

**For the two-laptop demo:** nothing changes. Shoppers can stay guests. To show the fairness point, sign both laptops in to the *same* account and press Add on a last-unit product: the second laptop is told it's already in your cart.

## Files

`server/db/migrations/006_accounts.sql`, `007_back_in_stock.sql` · `server/domain/accounts.ts`, `alerts.ts` · `server/workers/notifier.ts` · `web/src/components/NotifyMe.tsx` · `server/routes/accounts.ts` · `web/src/pages/Account.tsx` · `AccountProvider` in `web/src/state.tsx` · `scripts/accounts-test.ts`
