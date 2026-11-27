# Demo video and launch kit

## Video script (target 2:45, hard cap 3:00)

Record each shot separately at 1080p, with the browser at 110% zoom and the bookmarks bar hidden. **Blur every key** (the Flagsmith SDK keys page, `.env`, the terminal). Read the voice-over word for word and add captions.

| Time | Shot | Voice-over |
|---|---|---|
| 0:00–0:15 | Live store home page, live stock ticking | "StockHop is a city-aware store: every product shows live stock in your city. But nothing on the product page says what other shoppers think. Do reviews make people add to cart?" |
| 0:15–0:35 | `doc/experiment.md`: hypothesis + decision rule | "We wrote the hypothesis and the decision rule before any data: ship reviews at 95% win probability with no revenue loss, otherwise keep control." |
| 0:35–1:00 | Side by side: control vs reviews (identity overrides) | "One multivariate flag, product_trust_signal, splits shoppers 50/50. Same page; only the reviews block changes." |
| 1:00–1:25 | Network tab: flags, exposure, add_to_cart batch; then `useVariant` in `web/src/experiments.tsx` | "The exposure is recorded only where the difference is visible. Add to cart, checkout and revenue come from real store events." |
| 1:25–1:50 | Flagsmith experiment page: exposures, metrics. Terminal: `npm run exp -- results --env=prod` | "Flagsmith joins exposures and events per shopper and works out a win probability. We read the same numbers from the terminal." |
| 1:50–2:15 | README results table, real vs simulated | "Real shoppers: [numbers], so [decision]. Simulated shoppers live in their own environment; their lift is an input we chose, and it proves the pipeline. A 10% lift needs about 15,000 shoppers per version, so we didn't claim one." |
| 2:15–2:30 | End experiment → serve the winner; refresh the live site | "We ship the decision with the same flag. No redeploy." |
| 2:30–2:45 | Skill run sped up, then the experiment it created | "Track 04: our Agent Skill does all of this from one prompt with the Flagsmith CLI, asking before every change, in [N] tokens." |

### Filming both versions on the live site

1. Open the live store in a fresh incognito window and visit `/api/experiments/config`. Copy `identity`.
2. In Flagsmith (Production), open `product_trust_signal` and add an **identity override** for that identity (control in one window, reviews in another).
3. Production builds ignore `?ff_product_trust_signal=`, so use overrides, not the URL.
4. Remove the overrides after filming. They only affect your own identities, but keep it clean.
5. If Flagsmith blocks overrides because the running experiment locks the flag, film both versions locally instead: `npm run dev:app`, then `?ff_product_trust_signal=reviews` or `=control` on a product page (dev builds only).

## Share message (traffic waves)

Never say which version people will see, or that reviews are being tested. Just ask them to shop.

> Hey! We built **StockHop**, a store that shows live stock for your city, for a hackathon this weekend. Could you spend 2 minutes on it: browse, open a few products, add whatever you like to the cart? (Test mode, no real payments.) <LIVE LINK>

Waves: Fri night (friends and classmates), Sat noon (communities and groups), Sat evening (a reminder to anyone who hasn't opened it).

## Data freeze checklist (Sun 12:00 IST)

```bash
npm run exp -- results --env=prod --write
npm run exp -- results --env=sim --write
```

1. Exposures panel: about 50/50 and no sample-ratio warning, otherwise report that instead of a lift.
2. Apply the rule in [experiment.md](experiment.md#decision-rule) exactly as written.
3. In the dashboard, **End experiment** and choose the winner (or control). Check in a fresh browser.
4. Fill in the result tables in `doc/experiment.md` and `README.md`. Then open the clean-up PR that removes the losing version and the flag check.
