# 13: Payments (Razorpay Test Mode) and the two-laptop demo

Checkout now **takes a payment before confirming an order**. Everything runs in Razorpay **Test Mode**: no real money moves.

## How it works

```
Pay ─► POST /api/checkout
        one transaction, row-locked (unchanged): stock taken from the shelf, order saved as
        'pending_payment' with a hold (RESERVATION_MINUTES, default 10)
      ─► Razorpay Test order created (outside the transaction, so no network call holds row locks)
      ─► Razorpay Checkout opens in the browser
Paid ─► POST /api/payments/verify
        HMAC signature checked + payment fetched from Razorpay (status, order, amount)
        ─► order 'confirmed', OrderPlaced event ─► Kafka ─► notifier sends the confirmation
Closed / failed ─► POST /api/payments/cancel ─► stock returned (changeStock +qty, reason 'release'),
        order 'cancelled', cart given back
Never paid ─► hold expires; swept on the next checkout or order read
```

Every state change locks the order row first, so **paid** and **released** can never both happen.
If Test Mode keys are not configured, checkout confirms immediately as before.

Code: `server/domain/payments.ts`, `server/domain/checkout.ts`, `server/lib/razorpay-test.ts`, `web/src/razorpay.ts`, `web/src/pages/Checkout.tsx`. Schema: `server/db/migrations/002_payments.sql` (additive).

## Tests

`npm run payment:race` runs the API on a local port against the real database and Razorpay Test Mode:

| Scenario | Result (21 Nov 2026) |
|---|---|
| A. 5 shoppers press Pay at once on the last unit | 1 hold (HTTP 201, with Razorpay order), 4 × 409; stock 0; 1.4–2 s |
| A2. The 4 who lost are shown the same item from partner retailers; all 4 rush the cheapest partner (2 left) | each saw 2 partner offers; 2 holds + 2 × 409; partner stock 0, never negative; cancelled partner holds return to the partner, not our shelf |
| B. Forged payment proof; another shopper cancels my order | 400; 404; order still pending |
| C. Holder cancels; a waiting shopper retries | unit back (1); retry gets the hold |
| D. 2 units, 2 shoppers pay at once | both 201, distinct Razorpay orders; stock 0 |
| E. Cancel and expiry sweep on the same hold, at once | released exactly once (+1, not +2) |

Cleans up after itself (holds released, stock restored). A real **successful payment** needs a human in Razorpay's window, so it was checked in the browser: order SH-BLR-168 was confirmed after verification and the notifier sent the confirmation. Closing Checkout without paying returned the held unit (5 → 4 → 5).

`npm run checkout:race` (the earlier 5-shopper test) still passes and now releases its hold before restoring stock.

## Cart claims: told at "Add to cart", not at Pay

Adding to a cart claims those units for 15 minutes of cart activity (`CART_CLAIM_MINUTES`). If someone else already has the last unit in their cart, the next shopper is stopped at **Add to cart** with an "Out of stock for you" popup. It says why ("Someone got there first" / "Being paid for right now" / "Sold out here") and lists the same item from partner retailers with Buy buttons. The product page warns before they even try ("Someone else has the last Neckband Pro in their cart", plus **See other sellers**).

- The check runs under the inventory row lock, taken in its own statement so the count after it sees the previous shopper's committed claim. Our first version did the count inside the locking statement, and `payment:race` caught 2 of 5 shoppers getting the last unit.
- Claims are soft: they never change `inventory.qty`. Checkout is still the only place that takes stock, so an expired claim can't cause an oversell.
- `payment:race` scenario A0: 5 shoppers press Add on the last unit together → 1 × 200, 4 × 409 (`in_someone_cart`). The others' product page shows 0 available to them and offers partners. When the claimer removes it, the next shopper can add it. Passed on 3 consecutive runs.
- Checked in Chrome: with another session holding the last Neckband Pro, the product page showed the warning, quick-add on the shop page opened the popup with Echo & Ohm ₹1,099 and Gadget Gully ₹1,199, and "Buy from Echo & Ohm" opened checkout at ₹1,099 to Echo & Ohm. No console errors.

### "Where you can still get it"

The popup (and the product page's **See where you can still get it** button) calls `GET /api/where-to-buy?productId=&city=` and lists every place the shopper can still buy the item, in order, each with its own button:

1. **Same city, another shop**: partner retailers in their city → **Buy from Gadget Gully** goes straight to partner checkout.
2. **StockHop store in another city**: our own stock there, after other shoppers' cart claims → **Switch to Delhi** changes city and opens the product page, ready to add.
3. **Another city, another shop**: partners elsewhere → **Buy in Mumbai** changes city and opens checkout for that shop.

A green line says how many places have it ("Good news: you can still get Sport Buds. Found in 8 places on StockHop").

Checked in Chrome (Sport Buds, both Bengaluru units in two other carts): Add opened the popup with 2 + 2 + 4 options; **Buy in Mumbai** (Tune Street) switched to Mumbai and opened "Pay ₹1,599 to Tune Street"; **Switch to Delhi** opened the product in Delhi with Add to cart available. No console errors.

### 36 more products, 2 in every city

`npm run products:more` adds 36 products (`MORE_PRODUCTS` in `server/db/catalogue.ts`; fictional brands Pulse Audio, Lumen Sound, Kinetic, Volt Works, Nest and Co, Trail Line) to the live database without wiping it: 2 in stock in Bengaluru, Mumbai and Delhi, and 2 at every partner retailer. The catalogue is now 66 products. They reuse the photo of their kind (earbuds, watch, bottle…) until they get their own in `web/src/productPhotos.ts`. `demo:setup` resets them to 2 as well.

## Partner retailers: nobody leaves empty-handed

When our shelf can't serve a shopper (the item is sold out, or someone else just won the last unit), StockHop shows **the same product from partner retailers in their city** (fictional shops, two per city: `npm run sellers:seed`). On checkout the panel appears right under "Someone else just took the last …"; on product pages it lists partners under the stock table.

Buying from a partner is a one-item checkout (`POST /api/checkout/offer`) with the same guarantees: the partner's stock is taken by a conditional `UPDATE … WHERE qty >= n` under a row lock, the order is held, Razorpay is paid, the server verifies, and a cancelled or expired hold returns the units **to that partner**. Order lines record the seller ("Sold by Gadget Gully"). Tables: `sellers`, `seller_offers`, `order_items.seller_id` (migration `003_sellers.sql`). Code: `server/domain/offers.ts`, `web/src/components/PartnerOffers.tsx`.

Checked in the browser (21 Nov 2026): with our last Everyday Buds held by another shopper, Pay returned the message plus two partner offers (Gadget Gully ₹1,199, Echo & Ohm ₹1,299); "Buy from Gadget Gully" opened Razorpay at ₹1,199, the test payment was verified, and order SH-BLR-179 was confirmed, "Sold by Gadget Gully", with the sold-out line removed from the cart.

## Two-laptop demo

**Both laptops must use the same server**: the deployed Vercel site (needs `test_api_key` and `test_key_secret` in Vercel's environment variables) or one laptop's dev server. Pick the **same city** on both.

1. Before the demo: `npm run sellers:seed` once, then `npm run demo:setup`. In **all three cities** it sets 8 products to 1 unit (Everyday Buds, Studio Over-Ear Headphones, Neckband Pro, Classic Wired Earphones, Commuter Backpack, 10000mAh Power Bank, Pulse Fitness Band, Orbit Smartwatch) and Pocket Speaker to 2. It also gives every partner 2 of each last-unit product and clears old cart claims and payment holds. Rerun it between rehearsals.
   - **Add-to-cart race:** both laptops press **Add to cart** on the same last-unit product. One gets it; the other gets the "Out of stock for you" popup with partner sellers.
   - **Everyday Buds = 1**: the race
   - **Pocket Speaker = 2**: simultaneous payments
   - **Neckband Pro = 1**: the comeback
2. **The race.** Both laptops add Everyday Buds, fill checkout, and press **Pay** together. One sees Razorpay open; the other immediately sees *"Someone else just took the last Everyday Buds…"* **and, right below it, the same Everyday Buds from Gadget Gully (₹1,199) and Echo & Ohm (₹1,299)**. The second person taps **Buy from Gadget Gully**, pays, and gets an order "Sold by Gadget Gully". Both people leave with their earbuds, and neither left StockHop.
3. **Simultaneous payments.** Both add Pocket Speaker and pay at the same time. Both Razorpay windows open; both choose **Netbanking → any bank → Success**. Two confirmed orders; stock 0.
4. **The comeback.** Laptop A reserves Neckband Pro, then closes the Razorpay window. Laptop B, which was told it was taken, presses Pay again and gets it.
5. Show `/ops`: outbox, Kafka lag, the confirmation events.

Test payment: **Netbanking → any bank → Success** (or Failure to show a failed attempt). Run `npm run demo:setup` again to reset between rehearsals.
