import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, CATEGORY_LABEL, CITIES, cityName, inr, type CityCode, type LiveItem, type Nearby, type SearchItem, type WhereToBuy } from '../api';
import { useAccount, useCart, useCity, useToast } from '../state';
import { useSecondsSince, useStockCheckedAgo } from '../hooks';
import {
  flyToCart, gsap, lockScroll, menuOpen, modalIn, reducedMotion, stockChanged,
} from '../motion';
import { ProductImage } from './ProductImage';
import { NotifyMe } from './NotifyMe';
import { SearchBox } from './SearchBox';
import { useSaved } from '../lists';
import { useHoverPresence } from '../presence';
import { Similar } from './Similar';
import { Logo } from './Logo';

const NAV = [
  { to: '/shop', label: 'Shop' },
  { to: '/stores', label: 'Stores' },
  { to: '/how-it-works', label: 'How it works' },
  { to: '/help', label: 'Help' },
];

function CartIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 7h14l-1.2 11.1a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9L5 7Z" />
      <path d="M9 10V6a3 3 0 0 1 6 0v4" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h11" />
    </svg>
  );
}

/** Full-screen crimson menu (opened from the round button or the mobile header). */
function MenuOverlay({ onClose }: { onClose: () => void }) {
  const { city, openPicker } = useCity();
  const { count } = useCart();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (ref.current) menuOpen(ref.current);
    closeRef.current?.focus();
    lockScroll(true);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      lockScroll(false);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const { account, retailer } = useAccount();
  const links = [
    { to: '/', label: 'Home' }, ...NAV, { to: '/saved', label: 'Saved items' }, { to: '/cart', label: `Cart (${count})` },
    ...(retailer ? [{ to: '/retailer', label: `${retailer.name} dashboard` }] : []),
    account ? { to: '/account', label: 'Your account' } : { to: '/signin', label: 'Sign in' },
  ];
  return (
    <div className="menu-panel" ref={ref} role="dialog" aria-modal="true" aria-label="Menu">
      <button className="fab-close" onClick={onClose} ref={closeRef} aria-label="Close menu">
        <svg width="22" height="22" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
      <nav className="menu-links" aria-label="Main">
        {links.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.to === '/'} className="menu-link" onClick={onClose}>
            <span>{l.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="menu-foot">
        <span className="script">Shopping in</span>
        <button className="menu-city" onClick={() => { onClose(); openPicker(); }}>
          {city ? cityName(city) : 'Pick a city'} <span aria-hidden="true">(change)</span>
        </button>
        <Logo size={26} mono />
      </div>
    </div>
  );
}

/** Heart in the header: saved items, with a count. */
function SavedLink() {
  const { items } = useSaved();
  return (
    <Link to="/saved" className="saved-btn" aria-label={`Saved items, ${items.length}`} title="Saved items">
      <HeartIcon filled={items.length > 0} />
      {items.length > 0 && <span className="saved-n">{items.length}</span>}
    </Link>
  );
}

/** Sign in (guest) or the account's initial (signed in). Optional: nothing requires it. */
function AccountButton() {
  const { account, alerts, retailer } = useAccount();
  if (account === undefined) return null;
  // A shop owner (doc/18): their shop's dashboard is one tap away.
  const shopLink = retailer ? <Link to="/retailer" className="btn btn-sm shop-btn" title={`${retailer.name} dashboard`}>My shop</Link> : null;
  // Something you asked about is back on the shelf: a dot on your account button.
  const back = alerts.filter((a) => a.notifiedAt && a.qtyNow > 0).length;
  return account ? (
    <>
    {shopLink}
    <Link to="/account" className="acct-btn is-in"
      aria-label={`Your account: ${account.name}${back ? `. ${back} item${back > 1 ? 's' : ''} you asked about ${back > 1 ? 'are' : 'is'} back` : ''}`}
      title={back ? `${back} back in stock` : account.email}>
      {account.name.trim().charAt(0).toUpperCase()}
      {back > 0 && <span className="alert-dot" />}
    </Link>
    </>
  ) : (
    <Link to="/signin" className="acct-btn">Sign in</Link>
  );
}

export function Header() {
  const { city, openPicker } = useCity();
  const { count, hasShortItems } = useCart();
  const { pathname } = useLocation();
  const [menuOpenState, setMenuOpen] = useState(false);
  const close = useCallback(() => setMenuOpen(false), []);
  const showSearch = pathname !== '/' && pathname !== '/shop' && !pathname.startsWith('/ops') && !pathname.startsWith('/retailer');
  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <>
      {/* Always visible: navigation, your city and your cart stay one glance away. */}
      <header className="site">
        <div className="shell site-inner">
          <Link to="/" className="logo" aria-label="StockHop home">
            <Logo size={30} animate />
          </Link>

          <nav className="nav-main" aria-label="Main">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className="nav-link">{n.label}</NavLink>
            ))}
          </nav>

          {/* Search from anywhere. Home and Shop have their own big box, so not repeated there. */}
          {showSearch && (
            <div className="nav-search">
              <SearchBox variant="header" placeholder={`Search ${city ? cityName(city) : 'StockHop'}…`} label="Search StockHop" />
            </div>
          )}

          <div className="nav-tools">
            <button className="city-btn" onClick={openPicker} aria-label={`Shopping in ${city ? cityName(city) : 'no city yet'}. Change city`}>
              <PinIcon />
              <span>{city ? cityName(city) : 'Pick a city'}</span>
            </button>
            <AccountButton />
            <SavedLink />
            <Link to="/cart" className="cart-btn" aria-label={`Cart, ${count} ${count === 1 ? 'item' : 'items'}`}>
              <CartIcon />
              <span className="count">{count}</span>
              {hasShortItems && <span className="alert-dot" title="An item in your cart is running out" />}
            </Link>
            <button className="menu-btn" aria-expanded={menuOpenState} aria-label="Open menu" onClick={() => setMenuOpen(true)}>
              <MenuIcon />
            </button>
          </div>
        </div>
      </header>

      {menuOpenState && <MenuOverlay onClose={close} />}
    </>
  );
}

export function CityPicker() {
  const { city, setCity, pickerOpen, closePicker } = useCity();
  const first = useRef<HTMLButtonElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    first.current?.focus();
    modalIn(backdrop.current);
  }, [pickerOpen]);
  if (!pickerOpen) return null;
  return (
    <div className="modal-backdrop" ref={backdrop} onClick={() => city && closePicker()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="city-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && city && closePicker()}
      >
        <Logo size={26} />
        <h2 id="city-title" className="modal-title">Where are you shopping?</h2>
        <p className="muted">Stock is kept per city. We’ll only show what our stores near you actually have.</p>
        <div className="city-grid">
          {CITIES.map((c, i) => (
            <button
              key={c.code}
              ref={i === 0 ? first : undefined}
              className={`city-choice ${c.code === city ? 'active' : ''}`}
              onClick={() => setCity(c.code)}
            >
              {c.name}
              {c.code === city && <span className="city-current">Current</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * "Out of stock for you" popup. Opens when an add is refused (someone else has the last one in
 * their cart, is paying for it, or it's sold out) or from the product page's warning. Says why in
 * plain words, then offers the same item from partner retailers in this city, so the shopper can
 * still buy it here.
 */
export function StockModal() {
  const { unavailable: u, showUnavailable } = useCart();
  const { setCity } = useCity();
  const { toast } = useToast();
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [where, setWhere] = useState<WhereToBuy | null>(null);

  useEffect(() => {
    if (!u) return;
    setWhere(null);
    closeRef.current?.focus();
    modalIn(ref.current);
    lockScroll(true);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && showUnavailable(null);
    window.addEventListener('keydown', onKey);
    const ctrl = new AbortController();
    api<WhereToBuy>(`/where-to-buy?productId=${u.productId}&city=${u.city}`, {}, ctrl.signal).then(setWhere, () => {});
    return () => {
      ctrl.abort();
      lockScroll(false);
      window.removeEventListener('keydown', onKey);
    };
  }, [u, showUnavailable]);

  if (!u) return null;
  const close = () => showUnavailable(null);
  const buyPartner = (sellerId: number, city: string, cityLabel: string) => {
    close();
    if (city !== u.city) {
      setCity(city as CityCode);
      toast(`You’re now shopping in ${cityLabel}`);
    }
    navigate(`/checkout?seller=${sellerId}&product=${u.productId}`);
  };
  const goOurCity = (city: string, cityLabel: string) => {
    close();
    setCity(city as CityCode);
    toast(`You’re now shopping in ${cityLabel}. Add it to your cart here.`);
    navigate(`/p/${u.productId}`);
  };

  const ourOther = where?.otherCities.filter((c) => c.ours > 0) ?? [];
  const otherPartners = where?.otherCities.flatMap((c) => c.partners.map((o) => ({ ...o, city: c.city, cityName: c.cityName }))) ?? [];
  const places = where ? where.sameCityPartners.length + ourOther.length + otherPartners.length : 0;
  const here = cityName(u.city);
  const headline =
    u.reason === 'in_someone_cart' ? 'Someone else got it first' : u.reason === 'being_paid_for' ? 'Someone is paying for the last one' : `Sold out in ${here}`;
  const diff = (p: number) => {
    if (!where) return null;
    const d = p - where.ourPricePaise;
    return d === 0 ? null : <small className={d < 0 ? 'cheaper' : ''}>{d < 0 ? `${inr(-d)} less` : `${inr(d)} more`}</small>;
  };

  return (
    <div className="modal-backdrop" ref={ref} onClick={close}>
      <div className="modal stock-modal" role="dialog" aria-modal="true" aria-labelledby="stock-modal-title" onClick={(e) => e.stopPropagation()}>
        <button className="modal-x" onClick={close} ref={closeRef} aria-label="Close">×</button>
        <span className="stock-modal-tag">Out of stock for you · {here}</span>
        <h2 id="stock-modal-title" className="modal-title">{headline}</h2>
        <p className="stock-modal-why">{u.message}</p>

        {!where ? (
          <div className="offers is-loading" aria-busy="true"><div className="sk-line skeleton" style={{ width: '60%' }} /></div>
        ) : places === 0 ? (
          <p className="stock-found none">Nobody has {u.name} right now, in any city. Try again in 15 minutes: unpaid carts give it back.</p>
        ) : (
          <>
            <p className="stock-found">
              <b>Good news: you can still get {u.name}.</b> Found in {places} {places === 1 ? 'place' : 'places'} on StockHop. Pick one:
            </p>

            {where.sameCityPartners.length > 0 && (
              <section className="where-group">
                <h3><span className="where-step">1</span> Same city, another shop <em>{here}</em></h3>
                <ul>
                  {where.sameCityPartners.map((o) => (
                    <li key={o.sellerId} className="where-row best">
                      <div className="where-who"><b>{o.sellerName}</b><span>★ {o.rating.toFixed(1)} · {o.deliveryNote}</span></div>
                      <span className="where-price">{inr(o.pricePaise)}{diff(o.pricePaise)}</span>
                      <span className="offer-qty low">{o.qty} left</span>
                      <button className="btn btn-sm btn-primary" data-track="rescue-partner" onClick={() => buyPartner(o.sellerId, u.city, here)}>Buy from {o.sellerName}</button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {ourOther.length > 0 && (
              <section className="where-group">
                <h3><span className="where-step">2</span> StockHop store in another city</h3>
                <ul>
                  {ourOther.map((c) => (
                    <li key={c.city} className="where-row">
                      <div className="where-who"><b>StockHop {c.cityName}</b><span>Our own store · ships from {c.cityName}</span></div>
                      <span className="where-price">{inr(where.ourPricePaise)}</span>
                      <span className="offer-qty low">{c.ours} left</span>
                      <button className="btn btn-sm btn-ghost" data-track="rescue-city" onClick={() => goOurCity(c.city, c.cityName)}>Switch to {c.cityName}</button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {otherPartners.length > 0 && (
              <section className="where-group">
                <h3><span className="where-step">3</span> Another city, another shop</h3>
                <ul>
                  {otherPartners.map((o) => (
                    <li key={o.sellerId} className="where-row">
                      <div className="where-who"><b>{o.sellerName}</b><span>{o.cityName} · ★ {o.rating.toFixed(1)} · {o.deliveryNote}</span></div>
                      <span className="where-price">{inr(o.pricePaise)}{diff(o.pricePaise)}</span>
                      <span className="offer-qty low">{o.qty} left</span>
                      <button className="btn btn-sm btn-ghost" data-track="rescue-partner" onClick={() => buyPartner(o.sellerId, o.city, o.cityName)}>Buy in {o.cityName}</button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        <Similar productId={u.productId} city={u.city} compact onPick={close}
          title={`Or something similar, in stock in ${here} now`} />
        <div className="notify-row"><NotifyMe productId={u.productId} city={u.city} name={u.name} /></div>
        <p className="muted small stock-modal-foot">
          {u.reason === 'in_someone_cart' && 'If the other shopper doesn’t check out within 15 minutes, it comes back here. '}
          Every option is reserved the moment you press it, and you pay on StockHop.
        </p>
      </div>
    </div>
  );
}

export function Toast() {
  const { current } = useToast();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!current || !ref.current || reducedMotion()) return;
    gsap.fromTo(ref.current, { y: 24, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.5, ease: 'back.out(1.6)' });
  }, [current]);
  if (!current) return null;
  return (
    <div className="toast" role="status" key={current.id} ref={ref}>
      <span>{current.text}</span>
      {current.action && <Link to={current.action.to} className="toast-link">{current.action.label}</Link>}
    </div>
  );
}

/** "6 left in Bengaluru" / "Sold out here. 4 left in Mumbai". Fixed height so cards don't jump. */
export function StockLine({ qty, city, nearby, qtyRef }: {
  qty: number;
  city: string;
  nearby: Nearby | null;
  /** The number element, so a live change can animate it. */
  qtyRef?: Ref<HTMLSpanElement>;
}) {
  if (qty <= 0) {
    return (
      <p className="stock oos">
        <strong>Sold out in {cityName(city)}.</strong>
        {nearby && <span> {nearby.qty} left in {nearby.cityName}</span>}
      </p>
    );
  }
  return (
    <p className={`stock ${qty <= 2 ? 'low' : ''}`}>
      {qty <= 2 && 'Only '}
      <span className="qty" ref={qtyRef}>{qty}</span> left in {cityName(city)}
    </p>
  );
}

const agoText = (s: number) => (s < 2 ? 'just now' : s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`);

/**
 * "● Live · checked 2 s ago" under a stock count: where the shopper can see the number is current.
 * The version is the stock row's version in PostgreSQL; every committed sale or restock raises it.
 */
export function LiveStamp({ version }: { version?: number }) {
  const ago = useStockCheckedAgo();
  if (ago === null) return null;
  const stale = ago > 10;
  return (
    <p
      className={`live-stamp ${stale ? 'stale' : ''}`}
      title={`Stock version ${version ?? '–'}. Every sale or restock committed in our database raises this number; this card re-checks it every 1.5 s.`}
    >
      <span className="live-dot" aria-hidden="true" />
      {stale ? 'Reconnecting…' : <>Live · checked {agoText(ago)}</>}
    </p>
  );
}

/** "From our database · checked 2 s ago" for screens that read PostgreSQL directly. */
export function DbStamp({ at }: { at: number | null }) {
  const ago = useSecondsSince(at);
  if (ago === null) return null;
  return (
    <span className={`live-stamp inline ${ago > 10 ? 'stale' : ''}`} title="Read straight from PostgreSQL, the same record checkout uses. Refreshes every 3 s.">
      <span className="live-dot" aria-hidden="true" />
      From our database · checked {agoText(ago)}
    </span>
  );
}

/**
 * Product tile. Photo first, quiet text below, add-to-cart as a round button on the photo.
 * Renders whichever stock is newer: the search hit or the live poll (by stock version).
 */
/** "Why this matched" (doc/19): OpenSearch highlights, [[term]] → <mark>. */
function Why({ text }: { text: string }) {
  const parts = text.split(/(\[\[[^\]]+\]\])/g);
  return (
    <span className="card-why">
      {parts.map((t, i) => (t.startsWith('[[') ? <mark key={i}>{t.slice(2, -2)}</mark> : <span key={i}>{t}</span>))}
    </span>
  );
}

export function ProductCard({ item, live }: { item: SearchItem; live?: LiveItem }) {
  const { add } = useCart();
  const { toast } = useToast();
  const s = live && live.stockVersion >= item.stockVersion ? live : item;
  const [busy, setBusy] = useState(false);
  const prevQty = useRef(s.qty);
  const cardRef = useRef<HTMLElement>(null);
  const qtyRef = useRef<HTMLSpanElement>(null);
  const artRef = useRef<HTMLDivElement>(null);
  // A pointer resting on this card shows up on the retailer's "Live now" (presence.ts).
  const hover = useHoverPresence(item.productId);

  // Someone else bought (or restocked) this while it was on screen: the two-window demo moment.
  useEffect(() => {
    if (prevQty.current === s.qty) return;
    prevQty.current = s.qty;
    stockChanged(cardRef.current, qtyRef.current);
  }, [s.qty]);

  const onAdd = async () => {
    setBusy(true);
    try {
      if (!(await add(item.productId, 1))) return; // unavailable: the popup explains and offers partners
      flyToCart(artRef.current?.querySelector('.art') ?? null);
      toast(`Added ${item.name}`, { label: 'View cart', to: '/cart' });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add to cart');
    } finally {
      setBusy(false);
    }
  };

  const p = item.partners;
  return (
    <article className={`card ${s.inStock ? '' : 'oos'}`} ref={cardRef} {...hover}>
      <div className="card-media" ref={artRef}>
        <span className="live-ring" aria-hidden="true" />
        <Link to={`/p/${item.productId}`} className="card-art-link" tabIndex={-1} aria-hidden="true">
          <ProductImage imageKey={item.imageKey} productId={item.productId} sku={item.sku} name={item.name} />
        </Link>
        {!s.inStock && <span className="tag-oos">Sold out here</span>}
        <SaveButton item={item} />
        <button
          className="quick-add"
          data-track="add-to-cart"
          data-product={item.productId}
          onClick={onAdd}
          disabled={!s.inStock || busy}
          aria-label={s.inStock ? `Add ${item.name} to cart` : `${item.name} is sold out here`}
          title={s.inStock ? 'Add to cart' : 'Sold out here'}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="card-body">
        <Link to={`/p/${item.productId}`} className="card-name">{item.name}</Link>
        <span className="card-meta">{CATEGORY_LABEL[item.category] ?? item.category}</span>
        <span className="price">{inr(item.pricePaise)}</span>
        {item.why && <Why text={item.why} />}
        <StockLine qty={s.qty} city={item.city} nearby={s.nearby} qtyRef={qtyRef} />
        {/* Who sells it: our own store, and any partner shops in the city that have it too. */}
        <p className="card-seller">
          Sold by <b>StockHop {cityName(item.city)}</b>
        </p>
        {p && p.shops > 0 && (
          <Link to={`/p/${item.productId}#sellers`} className={`card-partners ${s.inStock ? '' : 'rescue'}`}>
            {s.inStock
              ? <>Also at {p.shops === 1 ? p.topShop : `${p.shops} local shops`} from {inr(p.minPricePaise)}</>
              : <>Get it from {p.shops === 1 ? p.topShop : `${p.shops} local shops`}, from {inr(p.minPricePaise)} →</>}
          </Link>
        )}
        <LiveStamp version={s.stockVersion} />
      </div>
    </article>
  );
}

/** Heart on a product photo: save it for later (kept in this browser, lists.ts). */
export function SaveButton({ item, large = false }: {
  item: Pick<SearchItem, 'productId' | 'sku' | 'name' | 'brand' | 'category' | 'pricePaise' | 'imageKey'>;
  large?: boolean;
}) {
  const { has, toggle } = useSaved();
  const { toast } = useToast();
  const on = has(item.productId);
  return (
    <button
      type="button"
      className={`save-btn ${on ? 'is-on' : ''} ${large ? 'save-lg' : ''}`}
      aria-pressed={on}
      aria-label={on ? `Remove ${item.name} from saved items` : `Save ${item.name} for later`}
      title={on ? 'Saved' : 'Save for later'}
      data-track={on ? 'unsave' : 'save'}
      data-product={item.productId}
      onClick={(e) => {
        e.preventDefault();
        const now = toggle(item);
        toast(now ? `Saved ${item.name}` : `Removed ${item.name} from saved`, now ? { label: 'View saved', to: '/saved' } : undefined);
      }}
    >
      <HeartIcon filled={on} />
      {large && <span>{on ? 'Saved' : 'Save for later'}</span>}
    </button>
  );
}

function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20s-7.5-4.6-9.3-9.2C1.4 7.4 3.6 4 7.1 4c2.1 0 3.6 1.2 4.9 2.9C13.3 5.2 14.8 4 16.9 4c3.5 0 5.7 3.4 4.4 6.8C19.5 15.4 12 20 12 20Z" />
    </svg>
  );
}

export function CardSkeleton() {
  return (
    <div className="card" aria-hidden="true">
      <div className="card-media"><div className="art skeleton" /></div>
      <div className="card-body">
        <div className="sk-line skeleton" style={{ width: '70%' }} />
        <div className="sk-line skeleton" style={{ width: '40%' }} />
        <div className="sk-line skeleton" style={{ width: '30%' }} />
      </div>
    </div>
  );
}

export function Stepper({ value, max, onChange, disabled }: { value: number; max: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <div className="stepper" role="group" aria-label="Quantity">
      <button onClick={() => onChange(value - 1)} disabled={disabled || value <= 1} aria-label="Decrease">−</button>
      <span aria-live="polite">{value}</span>
      <button onClick={() => onChange(value + 1)} disabled={disabled || value >= max} aria-label="Increase">+</button>
    </div>
  );
}

export function Footer() {
  const { city } = useCity();
  return (
    <footer className="site-footer">
      <div className="shell footer-grid">
        <div className="footer-brand">
          <Logo size={30} mono />
          <p>Electronics, home and travel essentials from stores in Bengaluru, Mumbai and Delhi, with stock you can trust.</p>
          {city && <p className="footer-city">You’re shopping in {cityName(city)}.</p>}
        </div>
        <nav aria-label="Shop">
          <h3>Shop</h3>
          <Link to="/shop">All products</Link>
          {Object.entries(CATEGORY_LABEL).map(([key, label]) => (
            <Link key={key} to={`/shop?category=${key}`}>{label}</Link>
          ))}
        </nav>
        <nav aria-label="StockHop">
          <h3>StockHop</h3>
          <Link to="/how-it-works">How it works</Link>
          <Link to="/stores">Our stores</Link>
          <Link to="/ops">Store console</Link>
        </nav>
        <nav aria-label="Help">
          <h3>Help</h3>
          <Link to="/help">Help centre</Link>
          <Link to="/help#delivery">Delivery and pickup</Link>
          <Link to="/help#returns">Returns</Link>
          <Link to="/help#contact">Contact us</Link>
        </nav>
      </div>
      <div className="shell footer-base">
        <span>Demo store built for Build Bengaluru 2.0. No real payments are taken.</span>
        <span className="footer-legal">
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
        </span>
      </div>
    </footer>
  );
}
