import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, CITIES, cityName, inr, type CityCode, type SearchResult, type ShopSummary } from '../api';
import { useCity } from '../state';
import { staggerIn, useGsap } from '../motion';
import { Mark } from '../components/Logo';

/** Shared layout for content pages: title block, then prose. */
function InfoPage({ title, lede, children }: { title: string; lede: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useGsap(() => staggerIn('.info-head > *, .info-body > *', { stagger: 0.04, duration: 0.5 }), [], ref);
  return (
    <main className="shell page info" ref={ref}>
      <header className="info-head">
        <h1 className="page-title">{title}</h1>
        <p className="info-lede">{lede}</p>
      </header>
      <div className="info-body">{children}</div>
    </main>
  );
}

/* ---------------- Stores ---------------- */

interface CityStats { inStock: number; low: number; total: number }

export function Stores() {
  const { city, setCity } = useCity();
  const [stats, setStats] = useState<Partial<Record<CityCode, CityStats>>>({});
  const [shops, setShops] = useState<ShopSummary[] | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    api<{ items: ShopSummary[] }>('/shops', {}, ctrl.signal).then((r) => setShops(r.items), () => setShops([]));
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    for (const c of CITIES) {
      api<SearchResult>(`/search?city=${c.code}&size=48`, {}, ctrl.signal).then((r) => {
        const inStock = r.items.filter((i) => i.inStock).length;
        const low = r.items.filter((i) => i.inStock && i.qty <= 2).length;
        setStats((s) => ({ ...s, [c.code]: { inStock, low, total: r.total } }));
      }, () => {});
    }
    return () => ctrl.abort();
  }, []);

  return (
    <InfoPage
      title="Our stores"
      lede="StockHop runs one store in each of three cities. Each store keeps its own stock, so what you can buy depends on where you are."
    >
      <div className="store-list">
        {CITIES.map((c) => {
          const s = stats[c.code];
          return (
            <section key={c.code} className={`store ${c.code === city ? 'is-current' : ''}`}>
              <div className="store-head">
                <h2>{c.name}</h2>
                {c.code === city && <span className="chip">You’re shopping here</span>}
              </div>
              <dl className="store-stats">
                <div><dt>In stock now</dt><dd>{s ? `${s.inStock} of ${s.total}` : '–'}</dd></div>
                <div><dt>Running low</dt><dd className={s && s.low > 0 ? 'low' : ''}>{s ? s.low : '–'}</dd></div>
              </dl>
              <p className="muted">Counts come straight from the store’s live inventory and change as people buy.</p>
              {c.code === city ? (
                <Link className="btn btn-primary" to="/shop">Shop {c.name}</Link>
              ) : (
                <button className="btn" onClick={() => setCity(c.code)}>Switch to {c.name}</button>
              )}
            </section>
          );
        })}
      </div>
      <p className="info-note">
        If something is sold out in your city, its product page shows which other city still has it. Orders are fulfilled
        by the store in the city you’re shopping in.
      </p>

      <h2 className="info-sub" id="partners">Partner shops</h2>
      <p className="muted">
        Local shops that sell through StockHop. Open one to see everything on its shelf, with live stock, or search for a
        shop by name from any search box.
      </p>
      <div className="partner-list">
        {(shops ?? []).map((s) => (
          <Link key={s.id} to={`/store/${s.slug}`} className={`partner-card ${s.city === city ? 'is-current' : ''}`}>
            <span className="partner-city">{s.cityName}{s.city === city && ' · near you'}</span>
            <b className="partner-name">{s.name}</b>
            <span className="partner-meta">★ {s.rating.toFixed(1)} · {s.deliveryNote}</span>
            <span className="partner-stock">
              <b>{s.inStock}</b> of {s.products} in stock{s.minPricePaise != null ? ` · from ${inr(s.minPricePaise)}` : ''}
            </span>
            <span className="partner-go">Visit shop →</span>
          </Link>
        ))}
        {shops === null && <p className="muted">Loading shops…</p>}
      </div>
    </InfoPage>
  );
}

/* ---------------- How it works ---------------- */

export function HowItWorks() {
  return (
    <InfoPage
      title="How StockHop works"
      lede="Most shops show a stock count that might be hours old. Ours is the count on the shelf, and checkout makes sure two people can’t buy the same last unit."
    >
      <section className="prose">
        <h2>For shoppers</h2>
        <ol className="steps steps-inline">
          <li>
            <span className="step-n">1</span>
            <h3>Pick your city</h3>
            <p>We show products from the store that can actually reach you, with that store’s count.</p>
          </li>
          <li>
            <span className="step-n">2</span>
            <h3>Search, even with typos</h3>
            <p>“bluetoth earphones” finds earbuds. Filter by category or price, and hide what’s sold out.</p>
          </li>
          <li>
            <span className="step-n">3</span>
            <h3>Watch counts move</h3>
            <p>When someone else buys, the number on your screen changes within a couple of seconds.</p>
          </li>
          <li>
            <span className="step-n">4</span>
            <h3>Place the order</h3>
            <p>Checkout claims the stock. If the last one went a moment earlier, you’re told straight away and nothing is charged.</p>
          </li>
        </ol>
      </section>

      <section className="prose">
        <h2>Under the hood</h2>
        <p>
          StockHop runs on three managed services from Aiven. Each does one job, and the order they run in is what keeps
          the counts honest.
        </p>
        <div className="pipeline">
          <div className="pipe-step">
            <b>PostgreSQL decides</b>
            <span>Checkout reduces stock, saves the order and records an event in one transaction. If there isn’t enough stock, nothing is saved.</span>
          </div>
          <div className="pipe-step">
            <b>Kafka carries the news</b>
            <span>Each committed change is published as an event. Search, confirmations and the live counts all react to it independently.</span>
          </div>
          <div className="pipe-step">
            <b>OpenSearch finds things</b>
            <span>A search-ready copy of the catalogue, kept in sync from those events. It forgives typos and answers in milliseconds.</span>
          </div>
        </div>
        <p>
          Search results are a fast, nearly-live view. The final word always comes from PostgreSQL at checkout. You can
          watch every part of this working on the <Link to="/ops">live system status page</Link>.
        </p>
      </section>
    </InfoPage>
  );
}

/* ---------------- Help ---------------- */

const FAQ: { id?: string; q: string; a: ReactNode }[] = [
  {
    q: 'Is the stock count accurate?',
    a: 'Yes. It comes from the store’s inventory and updates within seconds of every sale or restock. Checkout re-checks it, so you can never be sold an item that has already gone.',
  },
  {
    q: 'What happens if two people buy the last one at the same time?',
    a: 'Exactly one order succeeds. The other shopper sees a clear message straight away, nothing is charged, and we suggest the nearest city that still has it.',
  },
  {
    q: 'Why do prices and stock change when I switch city?',
    a: 'Each city has its own store and its own shelves. Your cart is kept per city too, so switching back brings your earlier cart back.',
  },
  {
    id: 'delivery',
    q: 'Delivery and pickup',
    a: 'This is a demo store built for a hackathon, so orders aren’t shipped. In a live version, orders would be fulfilled by the store in the city you’re shopping in.',
  },
  {
    id: 'returns',
    q: 'Returns',
    a: 'There’s nothing to return in the demo. A live version would accept returns at the store that fulfilled the order.',
  },
  {
    q: 'Do I pay anything?',
    a: 'No. Placing an order reserves the stock and sends a confirmation, but no payment is taken.',
  },
];

export function Help() {
  const { hash } = useLocation();
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    if (el instanceof HTMLDetailsElement) el.open = true;
    el?.scrollIntoView({ block: 'start' });
  }, [hash]);

  return (
    <InfoPage title="Help centre" lede="Answers to the questions people ask most. Everything here applies to all three cities.">
      <div className="faq">
        {FAQ.map((f) => (
          <details key={f.q} id={f.id}>
            <summary>{f.q}</summary>
            <p>{f.a}</p>
          </details>
        ))}
      </div>
      <section className="prose" id="contact">
        <h2>Contact us</h2>
        <p>
          StockHop is built by Team Rangers from Dr Ambedkar Institute of Technology for Build Bengaluru 2.0. During the
          event, find us at our table, or check the <Link to="/ops">live system status</Link> if something looks wrong.
        </p>
      </section>
    </InfoPage>
  );
}

/* ---------------- Legal ---------------- */

export function Terms() {
  return (
    <InfoPage title="Terms of use" lede="The short version: this is a demo store, nothing is sold for real, and the products are fictional.">
      <section className="prose">
        <p>StockHop is a hackathon project. Product names, brands and prices are placeholders, and orders are not fulfilled.</p>
        <p>No payment is taken. Any test payment flow uses a payment provider’s test mode only.</p>
        <p>The service is provided as is, for demonstration, and may be reset or taken offline at any time.</p>
      </section>
    </InfoPage>
  );
}

export function Privacy() {
  return (
    <InfoPage title="Privacy" lede="What we store when you use the demo, and why.">
      <section className="prose">
        <p>A cookie keeps your cart between visits. It holds a random ID, not your identity.</p>
        <p>If you place an order, we store the name, email and optional phone number you enter so we can show the order and send a confirmation. Use made-up details if you prefer; the demo works the same.</p>
        <p>Your chosen city is remembered in your browser. We don’t use advertising or analytics trackers.</p>
      </section>
    </InfoPage>
  );
}

/* ---------------- 404 ---------------- */

export function NotFound() {
  const { city } = useCity();
  return (
    <main className="shell page not-found">
      <Mark size={72} animate />
      <h1 className="page-title">This page hopped away</h1>
      <p className="muted">The link may be old, or the page never existed.</p>
      <div className="nf-actions">
        <Link to="/" className="btn btn-primary">Go to the home page</Link>
        <Link to="/shop" className="btn">Shop {city ? cityName(city) : 'all products'}</Link>
      </div>
    </main>
  );
}
