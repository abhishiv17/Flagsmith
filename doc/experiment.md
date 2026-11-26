# The experiment: what makes a shopper trust a product page?

## The question

StockHop's product page already shows price, live stock in the shopper's city and partner shop offers. It doesn't show what other shoppers thought of the product. Big marketplaces lead with reviews. A local store might do better leaning on something only it has: how many people **in your city** bought this item recently.

So which reassures a shopper enough to add to cart: reviews, local proof, or neither?

## Hypothesis

> Showing a trust signal on the product page raises the share of shoppers who add the product to their cart by at least 10% compared with the current page. Reviews and local proof are compared head to head to find which signal works better.

## Versions

One multivariate flag, `product_trust_signal` (setup in [flagsmith.md](flagsmith.md)):

| Version | What the shopper sees | Status |
|---|---|---|
| **control** | The product page as it is today | Live |
| **reviews** | Star rating and a short review from another shopper, near the price | In progress |
| **local-proof** | "N bought in your city this week", counted from real orders | In progress |

Everything else on the page is identical across versions.

## Metrics

| Role | Metric | Why |
|---|---|---|
| **Primary** | `add_to_cart`, occurrence per shopper | Fires early in a visit, so it collects enough data in the four days the hackathon runs |
| Secondary | `checkout_started`, `checkout_completed` | Checks that extra adds to cart turn into orders |
| Guardrail | `checkout_completed` revenue (Sum) | A version that sells more cheap items but less revenue isn't a win |

## Traffic

- **Split:** three equal parts across control, reviews and local-proof.
- **Real shoppers:** the live store link, shared as widely as we can.
- **Simulated shoppers:** a script drives many visitors through the store, each with its own identity, so every version gets enough exposures before the deadline. Simulated traffic is allowed by the hackathon rules. The demo will say which results came from which.

## Decision rule

Set before the data comes in, so we can't move the goalposts:

- **Ship a version** when its win probability on `add_to_cart` against control is **at least 95%** and its revenue guardrail is not worse.
- If neither trust signal reaches 95% by the deadline, **keep control** and report the result as inconclusive. That is a valid outcome.
- The winner is rolled out to 100% with the same flag. Losing versions and the flag are then removed from the code.

## Result

Filled in when the experiment ends: exposures per version, conversion rate, lift, win probability, and the decision.
