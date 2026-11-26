import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, CATEGORY_LABEL, cityName, inr, type CityCode, type ProductDetail } from '../api';
import { useCart, useCity, useToast } from '../state';
import { usePoll } from '../hooks';
import { flyToCart, productIntro, useGsap } from '../motion';
import { ProductImage } from '../components/ProductImage';
import { DbStamp, SaveButton, Stepper } from '../components/ui';
import { RecentlyViewed } from '../components/RecentlyViewed';
import { BoughtTogether, useTogether } from '../components/BoughtTogether';
import { noteViewed } from '../lists';
import { useViewPresence } from '../presence';
import { NotifyMe } from '../components/NotifyMe';
import { PartnerOffers } from '../components/PartnerOffers';
import { Similar } from '../components/Similar';
import { PriceAcrossCities } from '../components/PriceAcrossCities';
import { CouponBanner } from '../components/CouponBanner';
import { track } from '../track';

/** Product detail from PostgreSQL: authoritative price + stock in every city (doc/06 §2). */
export function Product() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { city, setCity } = useCity();
  const { add, cart, showUnavailable } = useCart();
  const { toast } = useToast();
  const [p, setP] = useState<ProductDetail | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const pageRef = useRef<HTMLElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  const loadedId = p?.productId ?? null;
  // Keep the retailer's live viewer count tied to an open, visible product page.
  useEffect(() => {
    const productId = Number(id);
    if (!Number.isInteger(productId) || productId <= 0 || !city) return;
    const seen = () => {
      if (document.visibilityState === 'visible') track('product_presence', { productId, city });
    };
    seen();
    const timer = window.setInterval(seen, 15_000);
    document.addEventListener('visibilitychange', seen);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', seen); };
  }, [id, city]);
  // Intro once per product, not on every 3 s refresh.
  useGsap(() => loadedId !== null && productIntro(), [loadedId], pageRef);
  // Live on the retailer dashboard within seconds (presence.ts); the clickstream above keeps history.
  useViewPresence(loadedId);
  const together = useTogether(loadedId ? [loadedId] : [], city);
  // "Recently viewed": once per product opened.
  useEffect(() => {
    if (p && loadedId !== null) noteViewed(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedId]);

  // Refresh every 3 s so the city table stays live during the demo.
  usePoll(async () => {
    try {
      setP(await api<ProductDetail>(`/products/${id}${city ? `?city=${city}` : ''}`));
      setLoadedAt(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? 'We couldn’t find that product.' : (e as Error).message);
    }
  }, 3000);

  if (error && !p) {
    return (
      <main className="shell page">
        <div className="notice error" role="alert">{error} <Link to="/shop">Back to shop</Link></div>
      </main>
    );
  }
  if (!p || !city) return <main className="shell page"><div className="pdp"><div className="art skeleton" /></div></main>;

  const here = p.stock.find((s) => s.city === city);
  const hereQty = here?.qty ?? 0;
  const best = p.stock.filter((s) => s.city !== city && s.qty > 0).sort((a, b) => b.qty - a.qty)[0];
  // What *this shopper* can still add: the shelf minus units in other shoppers' carts.
  const yours = p.forYou ? p.forYou.availableToYou : hereQty;
  const mine = cart?.items.find((i) => i.productId === p.productId)?.qty ?? 0;
  const max = Math.max(1, Math.min(10, yours - mine));
  const blocked = hereQty > 0 && yours - mine <= 0 && mine === 0 && p.forYou?.reason != null;

  const openOtherSellers = () =>
    showUnavailable({
      productId: p.productId,
      name: p.name,
      city,
      reason: p.forYou?.reason ?? 'sold_out',
      message: p.forYou?.reason === 'in_someone_cart'
        ? hereQty > 1
          ? `Other shoppers already have all ${hereQty} ${p.name} in their carts.`
          : `Someone else already has the last ${p.name} in their cart.`
        : p.forYou?.reason === 'being_paid_for'
          ? `Someone else is paying for the last ${p.name} right now.`
          : `${p.name} is sold out here.`,
    });

  const onAdd = async () => {
    setBusy(true);
    try {
      if (!(await add(p.productId, Math.min(qty, max)))) return; // popup explains and offers partners
      flyToCart(artRef.current?.querySelector('.art') ?? null);
      toast(`Added ${qty} × ${p.name}`, { label: 'View cart', to: '/cart' });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell page" ref={pageRef}>
      <CouponBanner />
      <nav className="crumbs">
        <Link to="/shop">Shop</Link> / <Link to={`/shop?category=${p.category}`}>{CATEGORY_LABEL[p.category] ?? p.category}</Link>
      </nav>
      <div className="pdp">
        <div className="pdp-art" ref={artRef}>
          <ProductImage imageKey={p.imageKey} productId={p.productId} sku={p.sku} name={p.name} priority credit />
        </div>
        <div className="pdp-info">
          <span className="brand">{p.brand} · {p.sku}</span>
          <h1 className="pdp-title">{p.name}</h1>
          <p className="price price-lg">{inr(p.pricePaise)}</p>
          {/* Real orders only (ClickHouse, source 'live'): a claim we can stand behind. */}
          {together?.boughtWeek != null && together.boughtWeek >= 2 && (
            <p className="bought-week"><span aria-hidden="true">🔥</span> {together.boughtWeek} bought in {cityName(city)} this week</p>
          )}
          {/* Who sells it: our own store first, then any partner shops in the city. */}
          <p className="sold-by">
            Sold by <b>StockHop {cityName(city)}</b>
            <span>Our own store · {hereQty > 0 ? `${hereQty} on the shelf` : 'sold out here right now'}</span>
          </p>
          <p className="desc">{p.description}</p>
          <div id="sellers">
            <PartnerOffers
              productId={p.productId}
              city={city}
              title={`Also sold by shops in ${cityName(city)}`}
              ourPricePaise={p.pricePaise}
              onBuy={(o) => navigate(`/checkout?seller=${o.sellerId}&product=${o.productId}`)}
            />
          </div>
          {p.attrs && <AttrRow a={p.attrs} />}
          {p.features && p.features.length > 0 && (
            <section className="pdp-block" aria-label="Highlights">
              <h2 className="pdp-h">Highlights</h2>
              <ul className="features">{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
            </section>
          )}
          {p.about && <p className="about"><b>Who it’s for · </b>{p.about}</p>}
          {p.uses && p.uses.length > 0 && (
            <p className="good-for">
              <span>Good for</span>
              {p.uses.map((u) => <Link key={u.key} className="good-for-chip" to={`/shop?use=${u.key}`}>{u.label}</Link>)}
            </p>
          )}

          <table className="stock-table">
            <caption>Stock by city <DbStamp at={loadedAt} /></caption>
            <tbody>
              {p.stock.map((s) => (
                <tr key={s.city} className={s.city === city ? 'current' : ''}>
                  <th scope="row">{s.cityName}{s.city === city && <span className="you"> (you)</span>}</th>
                  <td className={s.qty === 0 ? 'zero' : s.qty <= 2 ? 'low' : ''}>
                    {s.qty === 0 ? 'Out of stock' : s.city === city && blocked ? `${s.qty} left, in ${s.qty > 1 ? 'other shoppers’ carts' : 'someone’s cart'}` : `${s.qty} left`}
                  </td>
                  <td>
                    {s.city !== city && s.qty > 0 && (
                      <button className="link-btn" onClick={() => setCity(s.city as CityCode)}>Shop {s.cityName}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <PriceAcrossCities productId={p.productId} city={city} />

          {blocked ? (
            // Before they try: someone else already holds the last one(s) in their cart.
            <div className="held-warning" role="status">
              <strong>{hereQty > 1 ? `All ${hereQty} ${p.name} are in other shoppers’ carts.` : `Someone else has the last ${p.name} in their cart.`}</strong>
              <span>It’s out of stock for you in {cityName(city)} unless they don’t check out within 15 minutes.</span>
              <button className="btn btn-primary" onClick={openOtherSellers}>See where you can still get it</button>
              <NotifyMe productId={p.productId} city={city} name={p.name} />
            </div>
          ) : hereQty > 0 ? (
            <div className="buy-row">
              <Stepper value={Math.min(qty, max)} max={max} onChange={setQty} disabled={busy} />
              <SaveButton item={p} large />
              <button className="btn btn-primary" data-track="add-to-cart" onClick={onAdd} disabled={busy}>
                {busy ? 'Adding…' : 'Add to cart'}
              </button>
            </div>
          ) : (
            <div className="notice">
              Sold out in our {cityName(city)} store.
              {best && (
                <>
                  {' '}{best.qty} left in {best.cityName},{' '}
                  <button className="link-btn" data-track="rescue-city" onClick={() => setCity(best.city as CityCode)}>switch city</button>.
                </>
              )}
              <div className="notify-row"><NotifyMe productId={p.productId} city={city} name={p.name} /></div>
            </div>
          )}

          {p.tags.length > 0 && (
            <p className="tags">{p.tags.slice(0, 6).map((t) => <span key={t} className="tag">{t}</span>)}</p>
          )}
        </div>
      </div>
      {hereQty > 0 && !blocked && <BoughtTogether product={p} city={city} data={together} />}
      <ProductDetails p={p} />
      {/* doc/19: real alternatives on the shelf here, from OpenSearch more_like_this. */}
      <Similar productId={p.productId} city={city}
        title={hereQty > 0 && !blocked ? `Similar, in stock in ${cityName(city)}` : `Can’t get this one? Similar, in stock in ${cityName(city)} now`} />
      <RecentlyViewed exclude={p.productId} />
    </main>
  );
}

const CONN: Record<string, string> = {
  bluetooth: 'Bluetooth', wired: 'Wired', 'usb-c': 'USB-C', lightning: 'Lightning', 'micro-usb': 'Micro-USB',
  wifi: 'Wi-Fi', 'wireless-charging': 'Wireless charging', hdmi: 'HDMI',
};

/** The few facts shoppers compare first, as chips under the price (doc/19). */
function AttrRow({ a }: { a: NonNullable<ProductDetail['attrs']> }) {
  const chips = [
    a.batteryHours ? (a.batteryHours >= 72 ? `${Math.round(a.batteryHours / 24)}-day battery` : `${a.batteryHours} h battery`) : null,
    a.waterRating && a.waterRating !== 'none' ? a.waterRating : null,
    ...a.connectivity.filter((c) => c !== 'none').slice(0, 2).map((c) => CONN[c] ?? c),
    a.weightG ? (a.weightG >= 1000 ? `${(a.weightG / 1000).toFixed(1)} kg` : `${a.weightG} g`) : null,
    a.colour,
  ].filter(Boolean) as string[];
  if (!chips.length) return null;
  return <p className="attr-row">{chips.map((c) => <span key={c} className="attr">{c}</span>)}</p>;
}

/**
 * Marketplace-style detail sections (doc/19): About this item, Specifications grouped by section,
 * What's in the box, Warranty. All of it is indexed in OpenSearch, so it is searchable too.
 */
function ProductDetails({ p }: { p: ProductDetail }) {
  if (!p.about && !p.specs?.length) return null;
  const groups = new Map<string, { label: string; value: string }[]>();
  for (const s of p.specs ?? []) {
    if (s.group === 'Warranty') continue;
    groups.set(s.group, [...(groups.get(s.group) ?? []), { label: s.label, value: s.value }]);
  }
  return (
    <section className="pdp-details" aria-label="Product details">
      {p.about && (
        <div className="pdp-block">
          <h2 className="pdp-h">About this item</h2>
          <p className="about">{p.about}</p>
        </div>
      )}
      {groups.size > 0 && (
        <div className="pdp-block">
          <h2 className="pdp-h">Specifications</h2>
          <div className="spec-groups">
            {[...groups].map(([g, rows]) => (
              <table key={g} className="spec-table">
                <caption>{g}</caption>
                <tbody>{rows.map((r) => <tr key={r.label}><th scope="row">{r.label}</th><td>{r.value}</td></tr>)}</tbody>
              </table>
            ))}
          </div>
        </div>
      )}
      <div className="pdp-pair">
        {p.inBox && p.inBox.length > 0 && (
          <div className="pdp-block">
            <h2 className="pdp-h">What’s in the box</h2>
            <ul className="in-box">{p.inBox.map((b) => <li key={b}>{b}</li>)}</ul>
          </div>
        )}
        <div className="pdp-block">
          <h2 className="pdp-h">Warranty</h2>
          <p className="about">
            {p.warrantyMonths
              ? `${p.warrantyMonths} months. Bring it to any StockHop store in your city for a replacement.`
              : 'No warranty on this item.'}
          </p>
        </div>
      </div>
    </section>
  );
}
