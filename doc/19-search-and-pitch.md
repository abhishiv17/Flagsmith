# 19 · Search like you talk, and why StockHop

No new services: this round makes better use of **OpenSearch** and **PostgreSQL**, adds product detail so search has something to understand, and writes down the business pitch.

## The pitch: what big marketplaces still get wrong

Shown on the home page ("What big marketplaces still get wrong"), each point linked to something you can try:

| Big marketplaces | StockHop | Where to see it |
|---|---|---|
| "In stock" means a warehouse somewhere; delivery in days, or a cancellation after paying | Stock per city, from our database, live to the second | Every card: "● Live · checked N s ago" |
| The last unit gets sold twice; one buyer finds out by email | Whoever adds it first gets it (row lock); everyone else is told at **Add to cart** | Two-laptop race ([13](./13-payments-and-demo.md)) |
| "Currently unavailable": a dead end | Never a dead end: partner shop in your city, our store in another city, **something similar on the shelf here**, or a ping when it's back | "Out of stock for you" popup, product page |
| Search matches product names | **Describe the need**: "keep my tea hot on the commute under 800" | Shop search |
| Local shops are invisible online and lose the sale | Partner retailers sell through StockHop when we can't | Partner offers |
| The store never learns what people couldn't get | Missed demand by product and city, with a restock list | Store console `/ops` |

**Business model, in one line:** StockHop earns on every sale it *saves*. Our own sales are kept even when a unit is lost in a race, and partner retailers pay a commission on orders StockHop sends them (the rescued shopper). The retailer gets missed-demand data that tells them what to restock and where.

## Search like you talk

`server/lib/query-intent.ts` pulls the structured parts out of a sentence. OpenSearch matches the rest:

| Query | Understood (chips, removable) | Top result |
|---|---|---|
| keep my tea hot on the commute under 800 | Under ₹800 · Good for: Commute | Vacuum Flask 750ml (*Keeps tea hot for 12 hours*) |
| gift for dad under 2000 | Under ₹2,000 · Good for: Gifting | Ceramic Coffee Mug Set |
| noise cancelling headphones for flights | Good for: Travel | Travel ANC Headphones |
| earbuds between 1000 and 2000 in stock | ₹1,000–₹2,000 · In stock now | Everyday Buds |
| cheap power bank in mumbai | Cheapest first · In Mumbai | 10000mAh Power Bank (Mumbai stock, with a "switch to Mumbai" banner) |
| bluetoth earphones | (typo) | Everyday Buds |
| gifts for my gf | For your partner · Gifting | 3-in-1 Wireless Charger, ANC headphones, Halo Smart Ring |
| gift for dad | For Dad · Gifting | Power bank, anti-theft backpack, Care Watch SOS, smartwatch (no kids' items) |
| for my 10 year old nephew | For a kid · Kids | Kids School Bag, Kids Step Buddy, Kids GPS Watch |
| my phone keeps dying | Looking for: Power banks & chargers | 10000mAh Power Bank |
| stuff for my new apartment | Looking for: For a new home | Smart LED Bulb, desk lamp, fan, kettle |
| secret santa | For a friend · Under ₹1,000 | Mug, cable, earphones, sleep kit |
| xyz qwerty | (nothing matched) | Popular picks in stock, with a note saying so |

- **Prices** ("under 800", "2k", "between 1000 and 2000", "₹500-1000"), **availability** ("in stock", "today", "near me"), **city** ("in mumbai"), **cheapest first** ("cheap", "budget") and **occasions** (13 "good for" tags: commute, gym, travel, work from home, students, kids, gifting, monsoon, party, sleep, outdoors, kitchen, parents).
- Occasions **boost** results tagged for them; they don't hide the rest. Each result says **why it matched** (OpenSearch highlights on features and description).
- New facet: **Good for**, with counts.
- Each chip can be removed, which re-runs the search without it (`ignore=`).
- **Who it's for** (partner, mom, dad, grandparents, friend/colleague/sibling/secret santa, kid,
  teen/student, gamer, tech lover, traveller, fitness fan; also "10 year old", "70 year old") pulls the
  products that suit them up the list. A grown-up recipient leaves kids' products out. When the
  shopper also names the thing ("earbuds for my boyfriend"), the item wins and the recipient is a hint.
- **Needs said as problems** map to products: battery dying → power banks; music → earbuds and
  speakers; noise → ANC; new home → kettle, lamp, bulb, fan; losing things → GPS and SOS watches; back
  pain → stands and pillows; heat → fans; and more (`NEEDS` in `query-intent.ts`).
- **Chat words are ignored** ("what should I buy my…", "something", "help me"), so a sentence never
  fails because of them. Recipient words leave the text too ("dad" no longer fuzzy-matches "pad").
- **Never a dead end:** if nothing matches, the search loosens step by step (any one word with typos →
  what the sentence implied → popular picks in stock) and says so above the results.
- Tests: `npm test` (`server/lib/query-intent.test.ts`).

### Index v3 (`server/lib/search-schema.ts`)

- New fields `features` (searched, boosted 1.5) and `uses` (keyword: facet and boost).
- Need synonyms: *anc ↔ noise cancelling*, *waterproof ↔ ipx7 ↔ splash proof*, *hot ↔ insulated*, *gym ↔ workout*, *power cut ↔ load shedding*, *tiffin ↔ lunch box*…
- Stop words for natural sentences, and light English stemming ("keeps" finds "keep", "flights" finds "flight").
- The typo clause requires both words of a 2-word query in one field, so "bluetoth earphones" ranks Bluetooth earphones above wired ones.

### "Similar, in stock near you"

`GET /api/products/:id/similar?city=`: OpenSearch `more_like_this` on the product's own document, **filtered to what's on the shelf in the shopper's city**. Shown on every product page ("Can't get this one? Similar, in stock in Bengaluru now" when it's gone) and as another way out in the "out of stock for you" popup.

### Zero-downtime reindex

`npm run search:reindex` builds the new index from PostgreSQL with **external versions = the inventory version** (exactly what the indexer writes). It then swaps the alias in one atomic request and runs a catch-up pass, so changes made during the copy aren't lost. Stale writes are refused (409), so it's safe to re-run. Run live twice tonight (v1 → v2 → v3): **270/270 documents in sync, about 5 s, no downtime**. `npm run check:sync` agrees.

## OpenSearch Dashboards

Included with our Aiven OpenSearch; set up by `npm run dashboards:setup` (idempotent, through the Dashboards saved-objects API with the service credentials). Open `https://<opensearch host>/app/dashboards#/view/sh-dashboard` and sign in with the service's `avnadmin` user from the Aiven console.

- **Dashboard "StockHop · live stock and demand"** (refreshes every 10 s, last 24 h): products and units on shelves · sold out (product × city) · units by city · sold out by city · stock by category × city · good-for occasions · orders over time · shoppers who saw "sold out", by city · what shoppers search for (with the fewest results, to spot catalogue gaps).
- **Saved searches in Discover:** "Sold out right now", "Last units (1–2 left)", and a **typo search** (`bluetoth~1 AND earphones~1`) that shows the same fuzzy matching the storefront uses.
- It reads the **same index the storefront searches** (kept fresh by Kafka → indexer) and the `stockhop-activity` clickstream, so it moves during the two-laptop demo. At setup it showed 90 products, 965 units, 9 sold out, 201 orders.

## More, richer data

- **90 products** (was 66): 24 more everyday needs, such as an open-ear runner, sleep buds, a care watch with SOS for parents, a vacuum flask, an electric lunch box, a rechargeable fan for power cuts and a backpack rain cover. All have 2 in stock in every city and at every partner retailer.
- **Every product** now has 3–4 feature bullets and "good for" tags (`server/db/catalogue-details.ts`), shown on the product page and searched.
- Migration `009_product_details.sql` (applied): `products.features`, `products.uses`, carried in `InventoryChanged` events (additive; older events without them still index).

`npm run products:more` adds missing products and refreshes details for all 90. Run `npm run search:reindex` after.

## Known limits

- **Every product has its own photo** (90 products, 90 distinct photos, none shared). The 60 new ones came from Unsplash's free licence, picked per product, and checked on a contact sheet for the right item and no visible brand logos. Replacements were made where a logo showed (duffel bags, a branded speaker, bottled-water labels, a branded sleep mask). Photographers are credited in `web/src/productPhotos.ts`.
- No more products were seeded: 90 covers every category and occasion.
- Intent parsing is rules, not a language model: predictable, fast (adds under a millisecond) and explainable through the chips, but it only knows the phrases listed in `query-intent.ts`.
