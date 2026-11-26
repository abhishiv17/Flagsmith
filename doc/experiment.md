# The experiment: do reviews make shoppers add to cart?

## The question

StockHop's product page shows price, live stock in the shopper's city and partner shop offers, but nothing about what other shoppers think of the product. Big marketplaces lead with reviews. Do they earn their place on a local store's product page?

## Hypothesis

> Showing reviews on the product page (average rating, count and a recent review, with a full reviews section below) raises the share of shoppers who add the product to their cart by at least 10% compared with the page without reviews.

## Versions

One multivariate flag, `product_trust_signal` (setup in [flagsmith.md](flagsmith.md)). Everything else on the page is identical.

| Version | What the shopper sees |
|---|---|
| **control** | Today's product page, without reviews |
| **reviews** | Under the price: average star rating, review count and the latest well-rated review, linking down to a **Reviews** section with a rating breakdown, the latest reviews and a form to write one |

Code: [`web/src/pages/Product.tsx`](../web/src/pages/Product.tsx) and [`web/src/components/Reviews.tsx`](../web/src/components/Reviews.tsx).

## Metrics

| Role | Event | Metric | Why |
|---|---|---|---|
| **Primary** | `add_to_cart` | Occurrence, higher is better | Fires early in a visit, so it collects enough data in four days |
| Secondary | `checkout_started` | Occurrence | Checks that extra adds to cart turn into orders |
| Secondary | `checkout_completed` | Occurrence | Confirmed orders |
| Guardrail | `checkout_completed` (value = order total, ₹) | Sum, higher is better | Reviews that sell more cheap items but less revenue aren't a win |
| Informational | `review_submitted` (value = stars) | Occurrence | Do shoppers who see reviews write them? |

## Traffic

- **Split:** 50 / 50, with 100% of identified visitors enrolled.
- **Real shoppers:** the live store link, shared as widely as we can.
- **Simulated shoppers:** `npm run traffic:sim` ([`scripts/simulate-traffic.ts`](../scripts/simulate-traffic.ts)). Each one is a fresh Flagsmith identity (prefix `sim-`, trait `simulated = true`) that gets its version from Flagsmith and sends the same events as the store. **Its conversion rates are inputs we choose**, so simulated results prove the pipeline and the statistics work. They say nothing about real shoppers. We report simulated and real results separately.

## Decision rule

Set before any data comes in, so we can't move the goalposts:

- **Ship reviews** when their win probability on `add_to_cart` against control is **at least 95%** and the revenue guardrail is not worse.
- If reviews don't reach 95% by the deadline, **keep control** and report the result as inconclusive. That is a valid outcome.
- The winner is rolled out to 100% with the same flag. The losing version and the flag are then removed from the code.

## What we cut, and why

We first planned a third version, **local proof**: "🔥 N bought in Bengaluru this week", from real orders only. Before launch we measured how often it would actually show. Only **8 of 40 products** in Bengaluru, 9 of 40 in Mumbai and 4 of 40 in Delhi had a real order that week, and a 30-day window gave exactly the same numbers because the store had only been taking orders for a few days. For about 80% of shoppers, local proof would have looked the same as control.

Testing a version most people never see would dilute its effect and split our small audience three ways. So we cut it and run a cleaner two-version test. The existing "bought this week" badge stays on the page for everyone, in both versions, so it isn't part of what's tested.

## Known limitations

- **Demo reviews.** Like the products and partner shops, the starting reviews are generated (`npm run reviews:seed`, source `seed`). Reviews written on the site are stored separately (source `shopper`). The test measures the effect of showing reviews, not of these particular reviews.
- **Short window.** Four days of traffic from a small audience. A real store would run this for weeks.

## Result

Filled in when the experiment ends: exposures per version, add-to-cart rate, lift, win probability, the revenue guardrail, and the decision. Real and simulated traffic are reported separately.
