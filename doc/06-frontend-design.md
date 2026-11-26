# 06: Frontend Design

**Goal:** the live app should look like the deck the judges already saw (slide 3 mockup), so the demo reads as "they built what they pitched". Familiar storefront on top; the hard parts show through in small, honest signals (live stock, order confirmation, `/ops`).

## 1. Visual language (taken from the submission deck)

Neo-brutalist retail: cream paper, heavy black type, flat colour blocks, **hard offset shadows**, 2px black borders.

```css
/* web/src/styles/tokens.css */
:root {
  --paper:   #F4EFE4;   /* cream background (slides 1, 3, 4, 6) */
  --ink:     #1B1F1E;   /* text, borders, shadows */
  --muted:   #5B605D;   /* secondary text */
  --blue:    #2649E8;   /* primary / price / slide 2 */
  --yellow:  #F5E66E;   /* highlight chips, slide 5 */
  --coral:   #F47650;   /* alerts, out-of-stock, Kafka box */
  --lilac:   #E2E5FB;   /* tile bg (Travel Bottle) */
  --peach:   #F7D9CC;   /* tile bg (Pocket Speaker) */
  --white:   #FFFFFF;
  --ok:      #1F8A4C;

  --border: 2px solid var(--ink);
  --shadow: 6px 6px 0 var(--ink);
  --radius: 0;           /* square corners, like the deck */
  --font: "Inter", system-ui, sans-serif;   /* 800 for headings, 500 body */
}
```

Rules: prices in `--blue` bold; stock line in `--muted` ("Bengaluru · 1 left"); low stock (≤ 2) in `--coral`; out-of-stock cards greyed with a coral "Out of stock" tag. Use Google Fonts Inter only (no other external assets). Product images are **flat SVG illustrations** on coloured tiles (yellow / peach / lilac rotation), the same style as the mockup.

## 2. Routes & screens

| Route | Screen | Data source | Key states |
|---|---|---|---|
| `/` | Home: hero search bar, category chips, product grid for current city | `GET /search` (browse) | loading skeletons, empty, search-down |
| `/search?q=&category=&maxPrice=` | Results + facet sidebar (chips on mobile) + "⚡ 12 ms" badge | `GET /search` | no results → suggest clearing filters |
| `/p/:id` | Product detail: price, description, **stock in all 3 cities** table, qty stepper, Add to cart | `GET /products/:id` (PG) | out of stock here → "4 left in Mumbai · switch city" |
| `/cart` | Lines with live availability warnings, subtotal, banner for other-city carts | `GET /cart` | empty, `shortBy > 0` warning per line |
| `/checkout` | Name / email / phone form → Place order | `POST /checkout` | submitting (button disabled), 409 → list short items + "update cart" |
| `/orders/:id` | Big order number `SH-BLR-1042`, items, total, **"Sending confirmation… → Confirmation sent ✓"** | `GET /orders/:id` poll | |
| `/ops` | Pipeline dashboard (see §4) | `GET /ops/summary` every 2 s | service/worker down → coral tile |

**City picker:** modal on first visit (BLR / MUM / DEL, big buttons). Stored in `localStorage` (convenience only, wrapped in try/catch) and in the URL query for shareable links. The header shows `StockHop / Bengaluru ▾`, like the mockup.

## 3. Component list

`Header(city, cartCount)` · `CityPicker` · `SearchBar(debounced 250 ms)` · `CategoryChips` · `PriceFilter(presets: <₹500, ₹500–1,500, ₹1,500–3,000, ₹3,000+)` · `ProductCard(item, liveVersion)` · `StockLine(qty, city, nearby)` · `TookBadge(ms)` · `CartLine` · `CheckoutForm` · `OrderStatus` · `OpsTile` · `EventFeed` · `Toast`.

### ProductCard live behaviour
1. The `useLiveStock(city, productIds)` hook polls `GET /api/stock` every 1.5 s while the tab is visible.
2. It keeps a map `{ "1_BLR": {qty, version, nearby} }`.
3. A card renders the higher `stockVersion` of (search result, live map). On change it **flashes yellow for 800 ms** and re-renders the stock line ("1 left" → "Out of stock · 4 left in Mumbai").
4. If the card is in the open cart, the cart badge shows a coral dot.

This is the two-window "wow" moment, so it gets polish priority.

## 4. `/ops` page (the screen that proves the 3 services)

Layout: second browser window or projector half-screen.

```
┌ SERVICES ────────────┐ ┌ OUTBOX ──────┐ ┌ INDEX SYNC ────────┐
│ ● PostgreSQL  up     │ │ pending  0   │ │ 90 / 90 in sync ✓  │
│ ● Kafka       up     │ │ last id 1044 │ │ drift: none        │
│ ● OpenSearch  up     │ └──────────────┘ └────────────────────┘
└──────────────────────┘
┌ CONSUMER GROUPS ─────────────────────────────────────────────┐
│ search-indexer  inventory.changed   lag 0   ▁▁▁▃▇▃▁  (sparkline)
│ notifier        orders.placed       lag 0
│ notifier        inventory.changed   lag 0
└──────────────────────────────────────────────────────────────┘
┌ WORKERS ─────────────────────────────────────────────────────┐
│ ● relay  ● indexer  ● notifier  ● monitor   (heartbeat < 6 s) │
└──────────────────────────────────────────────────────────────┘
┌ LIVE EVENT FEED ─────────────────┐ ┌ STORE OPS ───────────────┐
│ 14:03:11 OrderPlaced  SH-BLR-1042│ │ ⚠ Low stock: Everyday    │
│ 14:03:11 InventoryChanged 1:BLR  │ │   Buds · BLR · 0 left    │
│          qty 1→0  v7→v8          │ │ 📧 Confirmation → a***@… │
└──────────────────────────────────┘ └──────────────────────────┘
```
During Drill 2 (kill indexer) the **lag number climbs and the sync tile turns coral ("87 / 90 in sync")**, then recovers. That visual is the point, so make lag and drift large and coloured.

## 5. Copy (tone: calm, specific, never blamey)

| Situation | Copy |
|---|---|
| Out of stock at checkout | "Someone just bought the last Everyday Buds in Bengaluru. Nothing was charged. 4 are available in Mumbai." |
| Cart short | "Only 1 left in Bengaluru. We'll confirm at checkout." |
| Order placed | "Order SH-BLR-1042 is confirmed." → "Confirmation sent to a***@example.com ✓" |
| Search down | "Search is catching its breath. Try again in a moment, or browse a product page." |
| No results | "Nothing for "xyz" in Bengaluru. Try fewer filters?" |

## 6. Quality bar

- Works at 375 px width (judges may open it on a phone): grid → 2 columns → 1 column.
- Keyboard: search focus with `/`, visible focus rings (2px ink outline).
- Contrast: ink on paper/yellow passes AA; don't put white text on yellow.
- No layout jump when the stock line changes (fixed height).
- Every fetch has loading + error UI; no blank screens.
