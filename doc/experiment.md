# The experiment: what makes a shopper trust a product page?

## The question

StockHop's product page shows price, live stock in the shopper's city and partner shop offers, but nothing about what other shoppers think. Big marketplaces lead with reviews. A local store has something they don't: it knows how many people **in your city** bought the item this week.

So which reassures a shopper enough to add to cart: reviews, local proof, or neither?

## Hypothesis

> Showing a trust signal on the product page raises the share of shoppers who add the product to their cart by at least 10% compared with a page that has none. Reviews and local proof are compared head to head to find which signal works better.

## Versions

One multivariate flag, `product_trust_signal` (setup in [flagsmith.md](flagsmith.md)). Everything else on the page is identical.

| Version | What the shopper sees under the price |
|---|---|
| **control** | Nothing extra |
| **reviews** | Average star rating, review count and the latest well-rated review, linking to a full **Reviews** section (rating breakdown, latest reviews, a form to write one) |
| **local-proof** | "🔥 N bought in Bengaluru this week", counted from real orders in the shopper's city |

Code: [`web/src/pages/Product.tsx`](../web/src/pages/Product.tsx) and [`web/src/components/Reviews.tsx`](../web/src/components/Reviews.tsx).

## Metrics

| Role | Event | Metric | Why |
|---|---|---|---|
| **Primary** | `add_to_cart` | Occurrence, higher is better | Fires early in a visit, so it collects enough data in four days |
| Secondary | `checkout_started` | Occurrence | Checks that extra adds to cart turn into orders |
| Secondary | `checkout_completed` | Occurrence | Confirmed orders |
| Guardrail | `checkout_completed` (value = order total, ₹) | Sum, higher is better | A version that sells more cheap items but less revenue isn't a win |
| Informational | `review_submitted` (value = stars) | Occurrence | Do shoppers who see reviews write them? Reviews version only |

## Traffic

- **Split:** three equal parts, 100% of identified visitors enrolled.
- **Real shoppers:** the live store link, shared as widely as we can.
- **Simulated shoppers:** `npm run traffic:sim` ([`scripts/simulate-traffic.ts`](../scripts/simulate-traffic.ts)). Each one is a fresh Flagsmith identity (prefix `sim-`, trait `simulated = true`) that gets its variant from Flagsmith and sends the same events as the store. **Its conversion rates are inputs we choose**, so simulated results prove the pipeline and the statistics work. They say nothing about real shoppers. We report simulated and real results separately.

## Decision rule

Set before any data comes in, so we can't move the goalposts:

- **Ship a version** when its win probability on `add_to_cart` against control is **at least 95%** and the revenue guardrail is not worse.
- If neither trust signal reaches 95% by the deadline, **keep control** and report the result as inconclusive. That is a valid outcome.
- The winner is rolled out to 100% with the same flag. Losing versions and the flag are then removed from the code.

## Known limitations

- **Local proof only shows when there's something to show.** It appears only for products with at least one real order in the shopper's city this week, which was 8 of 40 products sampled in Bengaluru on 26 Nov. On other products, local-proof looks the same as control, which dilutes its effect. This is an intention-to-treat comparison: everyone assigned to local-proof is counted, whether or not the badge appeared.
- **Demo reviews.** Like the products and partner shops, the starting reviews are generated (`npm run reviews:seed`, source `seed`). Reviews written on the site are stored separately (source `shopper`). The test measures the effect of showing reviews, not of these particular reviews.
- **Short window.** Four days of traffic from a small audience. A real store would run this for weeks.

## Result

Filled in when the experiment ends: exposures per version, add-to-cart rate, lift, win probability, the guardrail, and the decision. Real and simulated traffic are reported separately.
