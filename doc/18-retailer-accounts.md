# 18 · Retailer accounts, each with its own dashboard, and demo logins

Partner shops ([03_sellers](../server/db/migrations/003_sellers.sql)) can now sign in. A shop owner
signs in like a shopper (passwordless code, [17](./17-accounts.md)) with the shop's email and gets
**their own dashboard** at `/retailer` ("My shop" in the header). It shows only that shop's numbers:

- **Sales, orders, customers, repeat customers**, revenue per day (ClickHouse, `order_lines.seller_id`).
- **Your customers, by spend**: who buys most from you, how often, what they buy most, how often they
  look at your items, and a type (top customer · regular · gone quiet · bought once).
- **Looked at vs bought**: views of your items by shoppers in your city, buyers, units, sales, and how
  many you have left.
- **Last units on your shelf**: items at 1 left. That's where two shoppers race, and StockHop gives
  the unit to exactly one of them.
- **Live**: "N looking at your items now" (last 10 minutes) and the latest orders. The page refreshes
  every 15 s, so a sale made on another laptop shows up during the demo.
- **Coupons you gave**, with their status.

## Coupons: one customer, one shop

- A shop can only give a coupon to **its own regulars**: customers with **2+ orders at that shop**
  (`COUPON_MIN_ORDERS`). Anyone else is refused, server-side.
- The coupon works **only for that customer**: checkout requires being signed in with that email
  (`COUPON_REQUIRES_SIGN_IN`, doc/17). It works **only when buying from that shop**: a shop's coupon
  is refused on our own cart and at other shops, and a store coupon is refused at a shop
  (`coupons.seller_id`, migration 008). It also works **once** and **expires**.
- The link opens the item that customer looks at most (or buys most) **in the shop's city**. The
  banner says which shop it's from, with a direct "buy it from <shop>" link. At checkout the code is
  pre-filled and applied as soon as the customer is signed in.
- The coupon row is locked before the shop's stock row, and the coupon is marked used in the same
  statement as the order. Cancelling or expiring a payment hold frees it again.

## Privacy

- A shop sees **only its own buyers**. People who only looked at its items are counts, never names.
- A **real** customer's surname and email are masked in shop dashboards (`Abhi h.`, `a***@gmail.com`).
  The browser refers to customers by an opaque ref (HMAC), never by email. The demo shop logins below
  are shared for the pitch, so nothing real is readable through them. Demo people (`example.com` /
  `example.org`) are shown in full.
- The store-wide view (`/ops/customers`) still needs the admin token.

## Demo logins

All fictional. **No passwords:** type the email at `/signin` and the 6-digit code appears on screen
("Demo mode: email is simulated", `AUTH_DEMO_CODES=true`). A sign-in lasts 30 days on that browser.

**Retailers** (sign in, then open "My shop" → `/retailer`). Every item on these shelves is at **1 left**.

| Shop | City | Email |
|---|---|---|
| Gadget Gully | Bengaluru | `gadget.gully@example.com` |
| Echo & Ohm | Bengaluru | `echo.ohm@example.com` |
| Volt Bazaar | Mumbai | `volt.bazaar@example.com` |
| Circuit Corner | Delhi | `circuit.corner@example.com` |

**Each shop's top 2 customers** are named logins. Their orders are real (`/account` lists them), they
are #1 and #2 by spend on that shop's dashboard (30 and 60 days), and each holds an **open coupon from
that shop**: it applies only when they are signed in and buy from that shop, on any of its items. The
coupon's link opens the item they buy most there.

| Shop | Name | Email | Coupon |
|---|---|---|---|
| Gadget Gully | Asha Rao | `asha@example.com` | `GULLY10-ASHA` 10 % |
| Gadget Gully | Vikram Shetty | `vikram@example.com` | `GULLY15-VIKRAM` 15 % |
| Echo & Ohm | Meera Iyer | `meera@example.com` | `ECHO10-MEERA` 10 % |
| Echo & Ohm | Leela Menon | `leela@example.com` | `ECHO15-LEELA` 15 % |
| Volt Bazaar | Rohan Mehta | `rohan@example.com` | `VOLT10-ROHAN` 10 % |
| Volt Bazaar | Farhan Ali | `farhan@example.com` | `VOLT15-FARHAN` 15 % |
| Circuit Corner | Tanya Bose | `tanya@example.com` | `CIRCUIT10-TANYA` 10 % |
| Circuit Corner | Kabir Singh | `kabir@example.com` | `CIRCUIT20-KABIR` 20 % ("we miss you": nothing in 16 days) |

Also `dev@example.com` (Dev Patel): 1 order at Gadget Gully, 1 at Volt Bazaar; looks at Echo & Ohm a lot.
Asha also has 1 order at Echo & Ohm, and one old Gadget Gully order that used an earlier coupon.

**Fresh shoppers** (no history; for the live race): `nisha@example.com`, `arjun@example.com`, `zoya@example.com`.

Around them, each shop has 45 fictional customers on `example.org` (a few loyal regulars, most buying
once or twice) and anonymous browsers: ~540 shop orders and ~2,500 product views over two months,
in ClickHouse with `source = 'demo'`.

## Demo script (two laptops + the retailer)

1. **Laptop C:** sign in as `gadget.gully@example.com` → My shop. Asha is a regular there.
2. **Give a coupon:** Give coupon on Asha → 10 % → Copy link. Point out it only works for Asha, only at
   Gadget Gully, once. A one-order customer can't get one ("after 2nd order").
3. **Laptop A:** sign in as `asha@example.com`, open the link → the Gadget Gully banner → buy it from
   Gadget Gully → the coupon is applied. Laptop C shows the sale within seconds.
4. **The race:** laptop A as `nisha@example.com`, laptop B as `arjun@example.com`, both on Bengaluru and
   the same product → "Also sold by shops in Bengaluru" → Gadget Gully (1 left) → Pay at the same
   moment. One gets it; the other is told Gadget Gully just sold its last one and is offered another shop.
5. **Wrong person / wrong shop:** Nisha opening Asha's link is refused ("issued to a different email").
   The code at Echo & Ohm is refused ("This coupon is from Gadget Gully").
6. Reset the shelves to 1 left afterwards: `npm run demo:seed -- --shelf`.

## Reset / reseed

`npm run demo:seed` is idempotent: it sets the 4 owners, puts every item on their shelves at 1 left,
creates or keeps the 12 accounts, keeps the named shoppers' orders (fixed ids), re-opens the 8 top-customer
coupons for 30 days (unless used), and replaces the crowd in ClickHouse, trimming any crowd customer
who would outspend a shop's top 2. A used top-customer coupon stays used; give a new one from the dashboard. `-- --shelf` only resets the shelves.

## API

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/api/auth/me` | anyone | now also `retailer` (the shop this account runs) |
| GET | `/api/retailer/shop?days=30` | shop owner (or admin + `?seller=`) | the dashboard |
| GET | `/api/retailer/shop/customers/:ref` | shop owner | one of its customers |
| POST | `/api/retailer/shop/coupons` `{ref, percentOff, days, productId?}` | shop owner | coupon for a regular |
| GET | `/api/retailer/shops` | admin | shops with an owner |
| POST | `/api/coupons/preview` `{…, sellerId, productId}` | shopper | a shop coupon on that shop's item |
| POST | `/api/checkout/offer` `{…, couponCode}` | shopper | buy from a shop with its coupon |

Files: `server/db/migrations/008_retailers.sql`, `server/domain/retailers.ts`,
`server/routes/shop-dashboard.ts`, `web/src/pages/RetailerDashboard.tsx`, `scripts/demo-seed.ts`.
