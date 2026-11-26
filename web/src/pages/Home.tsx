import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, CATEGORY_LABEL, CITIES, cityName, inr, type CityCode, type LiveItem, type ProductDetail, type SearchItem, type SearchResult } from '../api';
import { useCart, useCity, useToast } from '../state';
import { useLiveStock, usePoll } from '../hooks';
import { carouselAmbience, carouselSwap, fanCards, flyToCart, headingReveal, heroIntro, marquee, ScrollTrigger, stockMapIntro, useGsap } from '../motion';
import { ProductCard } from '../components/ui';
import { SearchBox } from '../components/SearchBox';
import { RecentlyViewed } from '../components/RecentlyViewed';
import { KitStory } from '../components/KitStory';
import { ProductImage } from '../components/ProductImage';
import { cutoutFor, photoFor } from '../productPhotos';

/* ---------------- data helpers ---------------- */

/** The commute kit: a headline product and what travels with it (by imageKey). All have cut-outs. */
const KIT_HERO = 'headphones';
const KIT_KEYS = ['buds', 'watch', 'cable', 'backpack'];

function pickKit(items: SearchItem[]): { hero: SearchItem; kit: SearchItem[] } | null {
  const heroes = items.filter((i) => i.imageKey === KIT_HERO).sort((a, b) => Number(b.inStock) - Number(a.inStock) || b.pricePaise - a.pricePaise);
  const hero = heroes[0];
  if (!hero) return null;
  const kit = KIT_KEYS.map((k) => items.filter((i) => i.imageKey === k).sort((a, b) => Number(b.inStock) - Number(a.inStock))[0])
    .filter((i): i is SearchItem => Boolean(i));
  return kit.length >= 3 ? { hero, kit } : null;
}

/**
 * Hero product: always the flagship studio headphones (whether or not your store has them), so the
 * stock map tells the whole story: where it's in stock, and the hop when your shelf is empty.
 */
function pickHeroProduct(items: SearchItem[]): SearchItem | undefined {
  const withCutout = items.filter((i) => cutoutFor(i.imageKey, i.sku));
  return items.find((i) => i.sku === 'AUD-003') ?? withCutout[0] ?? items[0];
}

/** Carousel: the priciest in-stock products that have photos. */
function pickCarousel(items: SearchItem[]): SearchItem[] {
  return items.filter((i) => i.inStock && photoFor(i.imageKey, i.sku)).sort((a, b) => b.pricePaise - a.pricePaise).slice(0, 10);
}

/** One representative photo per category for the arc cards. */
const CATEGORY_COVER: Record<string, { imageKey: string; sku?: string; productId: number; blurb: string }> = {
  audio: { imageKey: 'headphones', sku: 'AUD-003', productId: 3, blurb: 'Earbuds, speakers, headphones' },
  wearables: { imageKey: 'watch', productId: 10, blurb: 'Watches, bands, rings' },
  'mobile-accessories': { imageKey: 'powerbank', productId: 15, blurb: 'Chargers, cables, power' },
  'home-kitchen': { imageKey: 'kettle', productId: 23, blurb: 'Kettles, lamps, bottles' },
  'bags-travel': { imageKey: 'backpack', productId: 25, blurb: 'Backpacks, duffels, pouches' },
  gaming: { imageKey: 'controller', sku: 'GAM-001', productId: 91, blurb: 'Controllers, keyboards, headsets' },
  'personal-care': { imageKey: 'trimmer', sku: 'CAR-001', productId: 92, blurb: 'Trimmers, dryers, massagers' },
  'smart-home': { imageKey: 'camera', sku: 'SMH-002', productId: 93, blurb: 'Cameras, plugs, lights' },
  fitness: { imageKey: 'yogamat', sku: 'FIT-001', productId: 94, blurb: 'Yoga, weights, health checks' },
  camera: { imageKey: 'instantcam', sku: 'CAM-005', productId: 95, blurb: 'Ring lights, mics, cameras' },
  computer: { imageKey: 'laptopstand', sku: 'CMP-002', productId: 96, blurb: 'Keyboards, stands, storage' },
};

interface Activity {
  id: number; productId: number; name: string; sku: string; imageKey: string;
  city: string; cityName: string; qty: number; delta: number; reason: 'order' | 'restock' | 'release'; at: string;
}

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const qtyOf = (item: SearchItem, live?: LiveItem) => (live && live.stockVersion >= item.stockVersion ? live.qty : item.qty);

/* ---------------- pieces ---------------- */

/** Script lead-in + giant condensed heading, each line revealed from a mask. */
function SecHead({ lead, lines, light = false, children }: { lead: string; lines: string[]; light?: boolean; children?: ReactNode }) {
  return (
    <div className={`sec-head ${light ? 'is-light' : ''}`}>
      <div>
        <span className="script">{lead}</span>
        <h2>
          {lines.map((l) => (
            <span key={l} className="line"><span>{l}</span></span>
          ))}
        </h2>
      </div>
      {children}
    </div>
  );
}

/**
 * The core idea in one picture: one product, its live count in each city's store, your city
 * highlighted, and, when your store is out, a hop line to the nearest city that still has it.
 * Counts come from PostgreSQL (product detail) and refresh every few seconds.
 */
function StockMap({ item, city, live }: { item: SearchItem; city: CityCode | null; live?: LiveItem }) {
  const [stock, setStock] = useState<ProductDetail['stock']>([]);
  usePoll(async () => {
    try {
      setStock((await api<ProductDetail>(`/products/${item.productId}`)).stock);
    } catch {
      /* keep last known counts */
    }
  }, 4000);

  // The live poll (search index) can be a moment ahead of the last product fetch for your city.
  const rows = stock.map((s) => (s.city === city && live && live.qty !== s.qty ? { ...s, qty: live.qty } : s));
  const mine = rows.find((s) => s.city === city);
  const others = rows.filter((s) => s.city !== city);
  const hop = mine && mine.qty === 0 ? [...others].filter((s) => s.qty > 0).sort((a, b) => b.qty - a.qty)[0] : undefined;
  // Fixed seats around the product: your city on the left, the other two on the right.
  const seats = [mine, ...others].filter((s): s is NonNullable<typeof s> => Boolean(s));

  // Animate in once, when the city counts first arrive (so every shelf exists to animate).
  const ref = useRef<HTMLDivElement>(null);
  const loaded = stock.length > 0;
  useGsap(() => (ref.current && loaded ? stockMapIntro(ref.current) : undefined), [loaded], ref);

  return (
    <div className="smap" ref={ref} aria-label={`${item.name}: stock by city`}>
      <svg className="smap-lines" viewBox="0 0 600 520" preserveAspectRatio="none" aria-hidden="true">
        <path className="smap-line" d="M150 150 C 210 170, 240 210, 300 250" />
        <path className="smap-line" d="M470 110 C 420 150, 380 200, 300 250" />
        <path className="smap-line" d="M470 400 C 420 360, 380 300, 300 250" />
        {hop && <path className={`smap-hop seat-${seats.indexOf(hop)}`} d={seats.indexOf(hop) === 1 ? 'M140 120 C 220 -10, 400 -10, 460 80' : 'M140 140 C 140 360, 330 470, 450 420'} />}
      </svg>

      <Link to={`/p/${item.productId}`} className="smap-product" aria-label={item.name}>
        <ProductImage imageKey={item.imageKey} productId={item.productId} sku={item.sku} name={item.name} priority cutout />
      </Link>

      {seats.map((s, i) => {
        const isMine = s.city === city;
        const isHop = hop?.city === s.city;
        return (
          <div key={s.city} className={`smap-city seat-${i} ${isMine ? 'is-mine' : ''} ${isHop ? 'is-hop' : ''} ${s.qty === 0 ? 'is-out' : ''}`}>
            <span className="smap-name">{s.cityName}{isMine && <em>You’re here</em>}</span>
            <b className="smap-qty">{s.qty > 0 ? <><span className="qty">{s.qty}</span> left</> : 'Sold out'}</b>
            {isHop && <span className="smap-note">Nearest with stock</span>}
          </div>
        );
      })}

      <p className="smap-caption">
        <b>{item.name}</b>, {inr(item.pricePaise)}. One product, three shelves, live counts.
      </p>
    </div>
  );
}

function Wave({ flip = false }: { flip?: boolean }) {
  return (
    <svg className={`wave ${flip ? 'wave-bottom' : 'wave-top'}`} viewBox="0 0 1440 90" preserveAspectRatio="none" aria-hidden="true">
      <path d="M-120 60 C 120 10, 360 10, 600 45 S 1080 95, 1320 50 S 1620 10, 1700 40 L 1700 90 L -120 90 Z" />
    </svg>
  );
}

function ProductsCarousel({ items, live, city }: { items: SearchItem[]; live: Map<number, LiveItem>; city: string }) {
  const [i, setI] = useState(0);
  const ref = useRef<HTMLElement>(null);
  const imgRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const { add } = useCart();
  const { toast } = useToast();
  useGsap(() => (ref.current ? carouselAmbience(ref.current) : undefined), [items.length > 0], ref);

  const item = items[i % items.length];
  if (!item) return null;
  const qty = qtyOf(item, live.get(item.productId));

  const go = (dir: 1 | -1) => {
    if (busy.current || !ref.current) return;
    busy.current = true;
    carouselSwap(ref.current, dir, () => setI((n) => (n + dir + items.length) % items.length));
    window.setTimeout(() => (busy.current = false), 900);
  };

  const onAdd = async () => {
    try {
      if (!(await add(item.productId, 1))) return; // popup explains and offers partners
      flyToCart(imgRef.current?.querySelector('.art') ?? null);
      toast(`Added ${item.name}`, { label: 'View cart', to: '/cart' });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add to cart');
    }
  };

  return (
    <section
      className="pc"
      ref={ref}
      aria-roledescription="carousel"
      aria-label="Featured products"
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') go(1);
        if (e.key === 'ArrowLeft') go(-1);
      }}
    >
      <Wave />
      <svg className="pc-rings" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        {[180, 280, 380, 480, 580].map((r) => <circle key={r} cx="500" cy="560" r={r} />)}
      </svg>
      <div className="shell pc-inner">
        <div className="pc-head">
          <span className="script">On the shelf in {cityName(city)}</span>
          <h2 className="pc-title">Our products</h2>
          <p className="pc-count" aria-live="polite">
            <b>{String((i % items.length) + 1).padStart(2, '0')}</b>
            <span>/ {String(items.length).padStart(2, '0')}</span>
          </p>
        </div>

        <div className="pc-stage">
          <div className="pc-circle" />
          <div className="pc-product" ref={imgRef}>
            <Link to={`/p/${item.productId}`} aria-label={item.name}>
              <ProductImage imageKey={item.imageKey} productId={item.productId} sku={item.sku} name={item.name} cutout />
            </Link>
          </div>
          <div className="pc-meta">
            <h3>{item.name}</h3>
            <p className="pc-price">{inr(item.pricePaise)}</p>
            <p className={qty <= 2 ? 'pc-stock low' : 'pc-stock'}>{qty > 0 ? `${qty} left in ${cityName(city)}` : 'Sold out here'}</p>
            <div className="pc-actions">
              <button className="btn btn-light" data-track="add-to-cart" data-product={item.productId} onClick={onAdd} disabled={qty <= 0}>Add to cart</button>
              <Link to={`/p/${item.productId}`} className="pc-view">View product</Link>
            </div>
          </div>
        </div>

        <div className="pc-arrows">
          <button onClick={() => go(-1)} aria-label="Previous product">
            <svg viewBox="0 0 48 24" aria-hidden="true"><path d="M46 12H4M12 3 3 12l9 9" /></svg>
          </button>
          <button onClick={() => go(1)} aria-label="Next product">
            <svg viewBox="0 0 48 24" aria-hidden="true"><path d="M2 12h42M36 3l9 9-9 9" /></svg>
          </button>
        </div>
      </div>
      <Wave flip />
    </section>
  );
}

/* ---------------- page ---------------- */

/** The pitch, each row tied to something you can try on the site (doc/19). */
const VS = [
  {
    them: '“In stock” means somewhere in a warehouse. Delivery in 4–6 days, or a cancellation after you paid.',
    us: 'Counts are per city, from our database, live to the second. If it says 1 left in Bengaluru, it’s on a shelf in Bengaluru.',
    cta: 'See live stock', to: '/shop?inStock=true',
  },
  {
    them: 'The last unit gets sold twice. One of you finds out by email, a day later.',
    us: 'The last unit goes to whoever adds it first, under a database lock. Everyone else is told at “Add to cart”, not after paying.',
    cta: 'How the race works', to: '/how-it-works',
  },
  {
    them: '“Currently unavailable.” A dead end, and you leave for another site.',
    us: 'Never a dead end: the same item from a partner shop in your city, our store in another city, something similar on the shelf here, or a ping when it’s back.',
    cta: 'Try a sold-out item', to: '/shop?q=headphones',
  },
  {
    them: 'Search matches product names. You have to know what the thing is called.',
    us: 'Describe the need: “keep my tea hot on the commute under 800”. We read the price, the occasion and the city, and show why each result fits.',
    cta: 'Search like you talk', to: '/shop?q=keep%20my%20tea%20hot%20on%20the%20commute%20under%20800',
  },
  {
    them: 'Local shops are invisible online, and lose the sale when the big store runs out.',
    us: 'Partner retailers in your city sell through StockHop when we can’t. The shopper still buys, the local shop gets the order.',
    cta: 'See partner shops', to: '/shop?q=everyday%20buds',
  },
  {
    them: 'The store never learns what people wanted and couldn’t get.',
    us: 'Every “sorry, it’s gone” is counted: missed demand by product and city, with a restock list for the store.',
    cta: 'Open the store console', to: '/ops',
  },
];

export function Home() {
  const { city } = useCity();
  const [browse, setBrowse] = useState<SearchResult | null>(null);
  const [cityCounts, setCityCounts] = useState<Partial<Record<CityCode, number>>>({});
  const [activity, setActivity] = useState<Activity[]>([]);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!city) return;
    const ctrl = new AbortController();
    setBrowse(null);
    api<SearchResult>(`/search?city=${city}&size=48`, {}, ctrl.signal).then(setBrowse, () => {});
    return () => ctrl.abort();
  }, [city]);

  useEffect(() => {
    const ctrl = new AbortController();
    for (const c of CITIES) {
      api<SearchResult>(`/search?city=${c.code}&inStock=true&size=1`, {}, ctrl.signal)
        .then((r) => setCityCounts((m) => ({ ...m, [c.code]: r.total })), () => {});
    }
    return () => ctrl.abort();
  }, []);

  usePoll(async () => {
    try {
      setActivity((await api<{ items: Activity[] }>('/activity')).items);
    } catch {
      /* strip stays as it was */
    }
  }, 6000);

  const items = browse?.items ?? [];
  const heroItem = useMemo(() => pickHeroProduct(items), [browse]); // eslint-disable-line react-hooks/exhaustive-deps
  const kit = useMemo(() => pickKit(items), [browse]); // eslint-disable-line react-hooks/exhaustive-deps
  const carousel = useMemo(() => pickCarousel(items), [browse]); // eslint-disable-line react-hooks/exhaustive-deps
  const goingFast = useMemo(
    () => items.filter((i) => i.inStock && i.qty <= 3).sort((a, b) => a.qty - b.qty).slice(0, 4),
    [browse], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const liveIds = useMemo(
    () => [...new Set([heroItem, ...carousel, ...goingFast, ...(kit ? [kit.hero, ...kit.kit] : [])].filter(Boolean).map((i) => i!.productId))],
    [heroItem, carousel, goingFast, kit],
  );
  const live = useLiveStock(city, liveIds);

  const pageRef = useRef<HTMLElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const tickerRef = useRef<HTMLDivElement>(null);
  const arcRef = useRef<HTMLDivElement>(null);
  const hasData = Boolean(browse);
  useGsap(() => (heroRef.current ? heroIntro(heroRef.current) : undefined), [], heroRef);
  useGsap(() => (activity.length > 0 ? marquee('.ticker-track') : undefined), [activity.length > 0], tickerRef);
  useGsap(() => (arcRef.current ? fanCards(arcRef.current) : undefined), [hasData], arcRef);
  useGsap(() => (pageRef.current ? headingReveal(pageRef.current) : undefined), [hasData], pageRef);

  // Sections arrive after first paint and move the pinned kit story: re-measure.
  const hasActivity = activity.length > 0;
  useEffect(() => {
    requestAnimationFrame(() => ScrollTrigger.refresh());
  }, [hasActivity, hasData]);


  const here = city ? cityName(city) : 'your city';
  const categories = browse?.facets.categories ?? Object.keys(CATEGORY_LABEL).map((key) => ({ key, count: 0 }));

  return (
    <main className="landing" ref={pageRef}>
      {/* ---------- Hero: the idea, shown with real data ---------- */}
      <section className="r-hero" ref={heroRef}>
        <div className="r-hero-grid">
          <div className="r-copy">
            <span className="script">Live stock, city by city</span>
            <h1 className="r-title" aria-label="Find it nearby. Buy with confidence.">
              <span className="line l1"><span>Find it nearby.</span></span>
              <span className="line l2"><span>Buy with confidence.</span></span>
            </h1>
            <p className="r-lede">
              Every product shows how many are on the shelf in {here} right now. If your store is out, we show you the
              nearest city that still has it. Checkout makes sure the last one only goes to one person.
            </p>
            <SearchBox variant="hero" value={q} onChange={setQ} placeholder={`Search ${here}. Try “bluetoth earphones”`}>
              <button type="submit" className="btn btn-primary">Search</button>
            </SearchBox>
          </div>

          {heroItem && <StockMap item={heroItem} city={city} live={live.get(heroItem.productId)} />}
        </div>
      </section>

      {/* ---------- Happening now: real sales and restocks ---------- */}
      {activity.length > 0 && (
        <section className="ticker" aria-label="Recent stock changes" ref={tickerRef}>
          <div className="ticker-track">
            {[0, 1].map((copy) => (
              <ul key={copy} className="ticker-list" aria-hidden={copy === 1}>
                {activity.map((a) => (
                  <li key={`${copy}-${a.id}`}>
                    <span className={a.reason === 'order' ? 'tick-dot sold' : 'tick-dot restock'} />
                    <b>{a.name}</b>
                    {a.reason === 'order'
                      ? ` taken in ${a.cityName}, ${a.qty} left`
                      : a.reason === 'release'
                        ? ` back on the shelf in ${a.cityName} (payment not completed), now ${a.qty}`
                        : ` restocked in ${a.cityName}, now ${a.qty}`}
                    <span className="tick-time">{ago(a.at)}</span>
                  </li>
                ))}
              </ul>
            ))}
          </div>
        </section>
      )}

      {/* ---------- The commute kit: pinned scroll story ---------- */}
      {kit && city && <KitStory hero={kit.hero} kit={kit.kit} live={live} city={city} />}

      {/* ---------- Products carousel (crimson) ---------- */}
      {carousel.length > 0 && city && <ProductsCarousel items={carousel} live={live} city={city} />}

      {/* ---------- Categories fanned on an arc ---------- */}
      <section className="shell l-section">
        <SecHead lead="Browse by" lines={['Category']}>
          <Link to="/shop" className="text-link">See all products</Link>
        </SecHead>
        <div className="arc" ref={arcRef}>
          {categories.map((c) => {
            const cover = CATEGORY_COVER[c.key];
            return (
              <Link key={c.key} to={`/shop?category=${c.key}`} className="arc-card">
                <span className="arc-photo">
                  {cover && <ProductImage imageKey={cover.imageKey} sku={cover.sku} productId={cover.productId} name="" />}
                </span>
                <span className="arc-text">
                  <b>{CATEGORY_LABEL[c.key] ?? c.key}</b>
                  <span>{cover?.blurb}{c.count > 0 ? `, ${c.count} products` : ''}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      {/* ---------- Pick up where you left off ---------- */}
      <div className="shell"><RecentlyViewed title="Pick up where you left off" /></div>

      {/* ---------- Going fast ---------- */}
      {goingFast.length > 0 && (
        <section className="shell l-section">
          <SecHead lead="Three or fewer left" lines={[`Going fast in ${here}`]}>
            <Link to="/shop?inStock=true" className="text-link">Everything in stock</Link>
          </SecHead>
          <div className="grid">
            {goingFast.map((item) => <ProductCard key={item.productId} item={item} live={live.get(item.productId)} />)}
          </div>
        </section>
      )}

      {/* ---------- How it works ---------- */}
      <section className="l-band">
        <div className="shell l-section">
          <SecHead lead="Something about" lines={['How buying works']}>
            <Link to="/how-it-works" className="text-link">The full story</Link>
          </SecHead>
          <ol className="steps">
            <li>
              <span className="step-n">01</span>
              <h3>Search your city’s shelves</h3>
              <p>Results only include what our {here} store stocks. Misspell it and we’ll still find it.</p>
            </li>
            <li>
              <span className="step-n">02</span>
              <h3>See the real count</h3>
              <p>Every product shows how many are left. When someone else buys, your screen updates within seconds.</p>
            </li>
            <li>
              <span className="step-n">03</span>
              <h3>Checkout secures your unit</h3>
              <p>Placing the order claims the stock. Two people can’t both get the last one, and nobody is charged for a sold-out item.</p>
            </li>
          </ol>
        </div>
      </section>

      {/* ---------- The pitch (doc/19): what big marketplaces still get wrong ---------- */}
      <section className="shell l-section">
        <SecHead lead="Why StockHop" lines={['What big marketplaces', 'still get wrong']} />
        <div className="vs-grid">
          {VS.map((v) => (
            <article key={v.them} className="vs-card">
              <p className="vs-them"><span>Big marketplaces</span><s>{v.them}</s></p>
              <p className="vs-us"><span>StockHop</span>{v.us}</p>
              <Link to={v.to} className="vs-try">{v.cta} →</Link>
            </article>
          ))}
        </div>
      </section>

      {/* ---------- Stores ---------- */}
      <section className="shell l-section">
        <SecHead lead="Three cities" lines={['One honest catalogue']}>
          <Link to="/stores" className="text-link">About our stores</Link>
        </SecHead>
        <div className="city-cards">
          {CITIES.map((c) => (
            <Link key={c.code} to="/stores" className={`city-card ${c.code === city ? 'is-current' : ''}`}>
              <span className="city-name">{c.name}</span>
              <span className="city-stat"><b>{cityCounts[c.code] ?? '–'}</b> of {browse?.total ?? '–'} products in stock now</span>
              {c.code === city && <span className="city-tag">You’re shopping here</span>}
            </Link>
          ))}
        </div>
      </section>

      {/* ---------- Closing call to action ---------- */}
      <section className="shell l-section">
        <div className="l-cta">
          <div>
            <span className="script">Ready when you are</span>
            <h2>Everything on the shelf in {here}</h2>
          </div>
          <Link to="/shop" className="btn btn-light btn-lg">Start shopping</Link>
        </div>
      </section>
    </main>
  );
}
