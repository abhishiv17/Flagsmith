# Experiment results log

Snapshots written by `npm run exp -- results --write`. Real and simulated shoppers are separate Flagsmith environments. Simulated conversion rates are inputs we chose: they prove the pipeline, not a finding.

## 2026-11-27T16:01:24.311256Z · Simulation (simulated shoppers)

Experiment 1458, status running. Raw response: [results/sim-2026-11-27T16-02-21-398Z.json](results/sim-2026-11-27T16-02-21-398Z.json)

| Metric | Version | Shoppers | Result | Lift vs control | 95% credible interval | Chance to beat control |
|---|---|---|---|---|---|---|
| Add to cart | control | 2007 | 10.8% (216) | — | — | — |
| Add to cart | reviews | 2043 | 13.1% (268) | +21.9% | +1.4% to +42.4% | 98.2% |
| Checkout started | control | 2007 | 4.8% (97) | — | — | — |
| Checkout started | reviews | 2043 | 5.6% (115) | +16.5% | -14.2% to +47.1% | 85.4% |
| Order completed | control | 2007 | 3.7% (74) | — | — | — |
| Order completed | reviews | 2043 | 4.7% (96) | +27.4% | -10.4% to +65.3% | 92.2% |
| Revenue | control | 2007 | ₹1,39,326 total | — | — | — |
| Revenue | reviews | 2043 | ₹2,24,604 total | +58.4% | +2.4% to +114.3% | 98.0% |
| Back-in-stock alert | control | 2007 | 0.0% (0) | — | — | — |
| Back-in-stock alert | reviews | 2043 | 0.0% (0) | — | — | — |
| Review submitted | control | 2007 | 0.0% (0) | — | — | — |
| Review submitted | reviews | 2043 | 0.0% (0) | — | — | — |

**Decision rule:** Ship reviews: 98.2% chance to beat control on add_to_cart (lift +21.9%), revenue not worse.
