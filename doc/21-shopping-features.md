# 21 · Shopping features: who sells it, shops, suggestions, live browsing

What a shopper expects from any online store, built on the services we already run.

## Who sells it

- Every product card says **Sold by StockHop {city}**, the same way partner offers name their shop.
  When partner shops in the city also have it: *Also at 2 local shops from ₹3,499*. When our shelf
  is empty: *Get it from Gadget Gully, from ₹3,659 →* (a way out straight from the grid).
- The product page shows **Sold by StockHop {city} · our own store · N on the shelf** above the
  partner offers.
- Search adds `partners: { shops, minPricePaise, topShop }` to each item (one PostgreSQL query per page).

## Partner shops in OpenSearch (`server/lib/shops-index.ts`)

- New index `shop_offers` (`OPENSEARCH_SHOPS_INDEX`): one document per (shop, product) with the
  shop's name (`search_as_you_type`), city and rating next to the product's text. Built from
  PostgreSQL on start-up and every 60 s. Only **matching** uses it: price and stock shown always come
  from `seller_offers` in PostgreSQL, so a partner sale is never shown late.
- **Search by shop name**: "gadget gully", "gadget gulli" (typo), "gully", or "gadg" as you type.
  The results open with the shop: rating, delivery, how many of its products are in stock, and its
  first items. The StockHop store's own results follow, labelled as such.
- **Storefront** `/store/:slug`: everything the shop sells, its price vs ours, live stock (refreshes
  every 4 s, counts flash when someone buys), categories, in-stock filter, sort, and search inside the
  shop through OpenSearch (typos, synonyms, prefixes). Buying from it uses the partner checkout.
- **Directory**: `/stores` lists every partner shop with live counts.
- API: `GET /api/shops`, `GET /api/shops/:slug?q=&category=&inStock=&sort=`.

## Search suggestions (`server/lib/suggest.ts`, `web/src/components/SearchBox.tsx`)

- `GET /api/suggest?q=&city=`: one OpenSearch request on the stock index using `name.sayt`.
  - **Completions** that continue what's typed: "pho" → *phone, phone tripod, photo*; "noise c" →
    *noise cancelling*. Typed part in normal weight, the rest bold.
  - **Products** on the shelf in the city, with price and live count; every typed word works as a
    prefix ("blu spe"); typos still match ("hedphones").
  - **Shops** whose name matches, and **categories**.
- Empty box: recent searches (kept in this browser, removable) and popular ones.
- Keyboard: ↑/↓ to move, Enter to pick, Esc to close. ARIA combobox/listbox.
- In the header on every page (except Home and Shop, which have their own large box), the Home hero
  and the Shop page.
- Tests: `server/lib/suggest.test.ts`.

## Live browsing on the retailer dashboard (`server/lib/presence.ts`)

The clickstream (doc/14) goes browser → 10 s batch → Kafka → ClickHouse: right for history, but
20–40 s late for "now". A separate fast path:

- The product page sends a **view** heartbeat every 5 s while it's open and visible; a product card
  sends a **hover** when the pointer rests on it for 350 ms (again every 4 s while it stays); adding to
  cart sends a **cart** beat. `POST /api/presence`.
- Stored in **Aiven for Valkey** (one sorted set per city, plus a short feed), falling back to the web
  process's memory when Valkey isn't configured.
- `GET /api/retailer/shop/live`: which of the shop's items shoppers in its city have open, are
  hovering over or just added to a cart, and the latest moments. The dashboard polls it every 2 s
  ("Live now" panel, header pill, a ● live tag in the items table); sales and history still refresh
  every 15 s from ClickHouse.
- Privacy: shoppers appear as "Shopper 3f2a", a per-shop hash of the visitor hash; never a name.

## Frequently bought together (`server/lib/together.ts`, `web/src/components/BoughtTogether.tsx`)

- `GET /api/together?ids=&city=`. **ClickHouse** finds products that were in the same orders
  (`order_lines` self-join; two or more shared orders, since one is chance). OpenSearch keeps only
  those **on the shelf in the shopper's city**. If that leaves fewer than 4, OpenSearch adds
  **complements**: same occasion ("good for commute"), another category. Co-purchases are cached for
  5 minutes.
- Product page: this item + up to 3 picks with ticks, a running total, and **Add all N to cart**. The
  subtitle says honestly where the picks came from (real orders, same uses, or both).
- Cart page: **Goes well with your cart**, one-tap add.
- Product page badge: **🔥 3 bought in Bengaluru this week**, from ClickHouse, **real orders only**
  (`source = 'live'`). The seeded demo history is never shown to shoppers as a claim, and the badge
  appears only from 2 units up.

## Trending searches

- The empty search box shows **Trending in {city} this week**: real searches from the clickstream
  (doc/14, OpenSearch activity index) that found something, ranked by distinct shoppers.
- Privacy and noise rules: a query must have been run by **2+ shoppers**, must share a real word with
  a product on the shelf (so test input like "xyz qwerty" never trends), and overlapping queries
  collapse. With too little data it falls back to the fixed popular list.

## Analytics for the new features (`/ops` → Shopper analytics)

- **Search suggestions taken**: picks by kind (completion, product, shop, category, recent, trending)
  and how many shoppers used them. Logged with the existing click tracking, including keyboard picks.
- **Bought together**: bundles added, picks opened, add-ons added from the cart.

## Also

- **Sort**: best match, price low→high / high→low, most in stock, name (`sort=` on `/api/search`).
- **Show more**: 24 results per page, the next page appended.
- **Saved items** (wishlist): a heart on every card and on the product page, `/saved` with live stock,
  a count in the header. Kept in this browser.
- **Recently viewed**: on the home page ("Pick up where you left off"), product pages and `/saved`.
