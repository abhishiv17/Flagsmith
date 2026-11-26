<div align="center">

# StockHop × Flagsmith

### What makes a shopper trust a product page?

An A/B test on a real online store, run with **Flagsmith feature flags** and **Flagsmith Experimentation**.

Team **Dark Launchers** · Toggle Wars: The Flagsmith Experimentation Hackathon (WeMakeDevs) · 26–29 Nov 2026 · Track 01, Test Something Real

</div>

---

## The experiment

StockHop is a city-aware online store: every product shows how many are on the shelf in your city, live, and the last unit can never be sold twice. Its product page shows price, stock and partner shop offers, but nothing about what other shoppers think.

Big marketplaces lead with reviews. A local store has something they don't: it knows how many people **in your city** just bought the item. So we test which one gets more shoppers to add to cart.

| | |
|---|---|
| **Hypothesis** | A trust signal on the product page raises the share of shoppers who add to cart by at least 10% over the current page |
| **Flag** | `product_trust_signal`, multivariate, split three ways |
| **Versions** | **control** (today's page) · **reviews** (star rating and a short review) · **local-proof** ("N bought in your city this week") |
| **Primary metric** | `add_to_cart`, per shopper |
| **Secondary and guardrail** | `checkout_started`, `checkout_completed` and order revenue |
| **Decision rule** | Ship a version at ≥ 95% win probability with no revenue loss; otherwise keep control |

Full plan and results: [doc/experiment.md](doc/experiment.md)

## How we use Flagsmith

```mermaid
flowchart LR
    S[StockHop server] -->|environment key +<br/>hashed visitor ID| B([Shopper browser])
    B -->|identify, fetch flags| F[[Flagsmith]]
    F -->|variant for this visitor| B
    B -->|exposure + add_to_cart,<br/>checkout events| F
    F --> R[Experiment results<br/>lift · win probability]
    R -->|roll out the winner<br/>with the same flag| F
```

- **One identity for flags and events.** The server gives each browser a one-way hash of its session, which Flagsmith uses as the identity. A shopper keeps their variant for the whole visit, even if they sign in.
- **Exposure is recorded where the change is seen.** `useVariant()` is called only in the component that renders the difference.
- **Conversions come from real store events:** add to cart from anywhere, placing an order, a confirmed order (with its total), and back-in-stock alerts.
- **The winner ships with the same flag.** No redeploy is needed.
- **Fails safe.** With no key set, or if Flagsmith is unreachable, everyone sees control and the store works as before.

Setup, code map, flags and events: [doc/flagsmith.md](doc/flagsmith.md)

## Run it

```bash
npm install
cp .env.example .env     # Aiven service URLs + FLAGSMITH_ENVIRONMENT_KEY
npm run demo:reset       # database, search index and catalogue
npm run dev:app          # http://localhost:5173
```

Requirements, deployment and checks: [doc/setup.md](doc/setup.md)

## Built with

- **Flagsmith**: feature flags and Experimentation (`@flagsmith/flagsmith` 12.4.0)
- **Aiven**: PostgreSQL, Apache Kafka, OpenSearch, Valkey, ClickHouse and App Runtime
- **App**: TypeScript, Express, React, Vite

How the pieces fit together: [doc/architecture.md](doc/architecture.md)

## Team Dark Launchers

Somya (lead) · Pradhyumna Kudtherkar · Zaiba Firdous · Abhishek M Shivanagoudar

## Credits

- StockHop was first built for Build Bengaluru 2.0 (21–22 Nov 2026), [original repository](https://github.com/abhishiv17/Stockhop). Everything after the `stockhop-base` tag was built for this hackathon.
- Libraries: express, pg, kafkajs, @opensearch-project/opensearch, ioredis, zod, react, react-router-dom, @huggingface/transformers, lenis, GSAP (GreenSock Standard No-Charge licence), @flagsmith/flagsmith.
- Embedding model: `Xenova/all-MiniLM-L6-v2` (Apache-2.0).
- Product photos: Unsplash and Pexels, each photographer credited in [`web/src/productPhotos.ts`](web/src/productPhotos.ts). Cut-out images: Wikimedia Commons, by Vijay Verma (CC0), Trent Huss (CC BY-SA 4.0), PantheraLeo1359531 (CC BY-SA 4.0) and SeriouslyBored (CC0).
- Fonts: Outfit, Anton, Caveat and JetBrains Mono (Google Fonts, OFL).
- Product names, brands and partner shops in the demo catalogue are fictional.
- AI coding assistants were used, as allowed by the hackathon rules.

## Security

Credentials come from environment variables only. `.env` and `certs/` are git-ignored; [`.env.example`](.env.example) lists the variable names.
