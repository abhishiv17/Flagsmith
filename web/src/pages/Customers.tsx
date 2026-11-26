import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, cityName, inr } from '../api';

/**
 * Store console → Customers (doc/16). For the retailer: who buys the most, who keeps browsing, what
 * converts, and a one-click loyalty coupon for a chosen customer.
 *
 * Numbers come from Aiven for ClickHouse (orders + every click, streamed from Kafka). Coupons are
 * written to PostgreSQL, which checkout checks. Customer names and emails are shown, so the page needs
 * the store's admin token (kept in this browser tab only).
 */

type Segment = 'vip' | 'browser' | 'lapsed' | 'regular' | 'new';
interface Customer {
  email: string; name: string; orders: number; spendPaise: number; units: number; lastOrder: string | null;
  cities: string[]; couponsUsed: number; live: boolean; favourite: string; events: number; views: number;
  cartAdds: number; searches: number; lastSeen: string | null; segment: Segment;
  suggestion: { label: string; percent: number; why: string };
  topCity: string | null; viewedId: number | null; favouriteId: number | null; viewedName: string | null; favouriteName: string | null;
}
interface Overview {
  windowDays: number; includesDemo: boolean;
  totals: { orders: number; customers: number; revenuePaise: number; discountPaise: number; couponOrders: number; visitors: number; events: number; productViews: number; cartAdds: number };
  customers: Customer[]; engaged: string[];
  daily: { day: string; orders: number; revenuePaise: number; visitors: number }[];
  products: { productId: number; name: string; views: number; viewers: number; cartAdds: number; units: number; revenuePaise: number; buyers: number }[];
  clickhouse: { queries: number; ms: number; rowsRead: number };
}
interface Coupon {
  code: string; customerEmail: string; percentOff: number; reason: string; expiresAt: string; createdAt: string;
  redeemedOrderId: string | null; redeemedAt: string | null; productId: number | null; city: string | null; link: string | null;
}
const CITY_CODES = ['BLR', 'MUM', 'DEL'] as const;
const fullLink = (c: Pick<Coupon, 'link'>) => (c.link ? `${window.location.origin}${c.link}` : '');
interface Spread { productId: number; name: string; ownPricePaise: number; minPaise: number; maxPaise: number; cheapestCity: string; dearestCity: string }
interface Detail {
  email: string;
  orders: { orderNumber: string; at: string | null; city: string; totalPaise: number; discountPaise: number; coupon: string; items: number; demo: boolean }[];
  bought: { name: string; units: number; spendPaise: number }[];
  looked: { name: string; views: number }[];
  coupons: Coupon[];
}

const TOKEN_KEY = 'stockhop:admin-token';
const readToken = () => { try { return sessionStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; } };
const saveToken = (t: string) => { try { sessionStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ } };

export const fmt = new Intl.NumberFormat('en-IN');
export const rupeesShort = (paise: number) => {
  const r = paise / 100;
  return r >= 1e5 ? `₹${(r / 1e5).toFixed(r >= 1e6 ? 1 : 2)} L` : `₹${fmt.format(Math.round(r))}`;
};
export const ago = (iso: string | null) => {
  if (!iso) return '—';
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};

const SEGMENT_TEXT: Record<Segment, string> = {
  vip: 'Top customer', browser: 'Browses a lot', lapsed: 'Gone quiet', regular: 'Regular', new: 'New',
};

export function Customers() {
  const [token, setToken] = useState(readToken);
  const [tokenInput, setTokenInput] = useState('');
  const [days, setDays] = useState(30);
  const [demo, setDemo] = useState(true);
  const [data, setData] = useState<Overview | null>(null);
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [spread, setSpread] = useState<Spread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [giving, setGiving] = useState<Customer | null>(null);
  const [viewing, setViewing] = useState<Customer | null>(null);

  const call = useCallback(<T,>(path: string, init: RequestInit = {}) =>
    api<T>(path, { ...init, headers: { 'x-admin-token': token, ...(init.headers ?? {}) } }), [token]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [o, c, s] = await Promise.all([
        call<Overview>(`/retailer/customers?days=${days}&demo=${demo ? 1 : 0}`),
        call<{ items: Coupon[] }>('/retailer/coupons'),
        call<{ items: Spread[] }>('/retailer/price-spread'),
      ]);
      setData(o);
      setCoupons(c.items);
      setSpread(s.items);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setToken('');
        saveToken('');
        setError('That admin token wasn’t accepted.');
      } else {
        setError((e as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, [call, days, demo, token]);

  useEffect(() => { void load(); }, [load]);
  // Live orders stream in through Kafka: refresh every 15 s while the page is open.
  useEffect(() => {
    if (!token) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 15_000);
    return () => clearInterval(t);
  }, [load, token]);

  if (!token) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      const t = tokenInput.trim();
      if (!t) return;
      saveToken(t);
      setToken(t);
      setTokenInput('');
    };
    return (
      <main className="shell page ops">
        <ConsoleTabs />
        <h1 className="page-title">Customers</h1>
        <form className="box form token-form" onSubmit={submit}>
          <p className="muted">This page shows your customers’ names and emails, so it needs the store’s admin token.</p>
          {error && <p className="coupon-bad small" role="alert">{error}</p>}
          <label>
            Store admin token
            <input type="password" autoComplete="off" data-no-track value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} />
          </label>
          <button className="btn btn-primary">Open</button>
        </form>
      </main>
    );
  }

  const t = data?.totals;
  const engaged = data ? data.engaged.map((e) => data.customers.find((c) => c.email === e)).filter((c): c is Customer => !!c) : [];

  return (
    <main className="shell page ops cust">
      <ConsoleTabs />
      <div className="ops-head">
        <h1 className="page-title">Customers</h1>
        {data && (
          <span className="live-pill ch-pill" title="Aiven for ClickHouse: orders and every click, streamed from Kafka">
            ClickHouse · {data.clickhouse.queries} queries · {Math.round(data.clickhouse.ms)} ms · {fmt.format(data.clickhouse.rowsRead)} rows read
          </span>
        )}
      </div>
      <p className="muted flow">
        Who buys the most, who keeps coming back to look, and what they look at. Pick a customer and give them a personal
        coupon; they type it at checkout with the same email.
      </p>

      <div className="cust-controls">
        <label className="toggle">
          Last
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} />
          Include demo history <span className="muted small">(40 fictional shoppers, seeded)</span>
        </label>
        {loading && <span className="muted small">updating…</span>}
        <button type="button" className="link-btn small" onClick={() => { saveToken(''); setToken(''); }}>Lock</button>
      </div>

      {error && <div className="notice error" role="alert">{error}</div>}

      {t && data && (
        <>
          <div className="ops-grid">
            <Tile title="Revenue" value={rupeesShort(t.revenuePaise)} note={`${fmt.format(t.orders)} orders · avg ${t.orders ? rupeesShort(t.revenuePaise / t.orders) : '—'}`} />
            <Tile title="Customers" value={fmt.format(t.customers)} note={`${data.customers.filter((c) => c.orders > 1).length} ordered more than once`} />
            <Tile title="Visitors who bought" value={t.visitors ? `${Math.round((t.customers / t.visitors) * 100)}%` : '—'} note={`${fmt.format(t.customers)} of ${fmt.format(t.visitors)} visitors`} />
            <Tile title="Looked → added to cart" value={fmt.format(t.cartAdds)} note={`from ${fmt.format(t.productViews)} product views`} />
            <Tile title="Coupon orders" value={fmt.format(t.couponOrders)} note={t.discountPaise ? `${inr(t.discountPaise)} given as discounts` : 'none redeemed yet'} />
          </div>

          <RevenueChart daily={data.daily} />

          <section className="box tile wide">
            <h2 className="tile-title">Top customers by spend <span className="muted small">(click a name for their history)</span></h2>
            <div className="table-scroll">
              <table className="md-table cust-table">
                <thead>
                  <tr>
                    <th>Customer</th><th>Type</th><th className="num">Orders</th><th className="num">Spent</th>
                    <th className="num" title="Product pages viewed">Views</th><th className="num" title="Add-to-cart clicks">Cart adds</th>
                    <th>Buys most</th><th>Last order</th><th />
                  </tr>
                </thead>
                <tbody>
                  {data.customers.slice(0, 15).map((c) => (
                    <tr key={c.email}>
                      <td>
                        <button type="button" className="link-btn cust-name" onClick={() => setViewing(c)}>{c.name || c.email}</button>
                        <div className="muted small">{c.email}{!c.live && ' · demo'}</div>
                      </td>
                      <td><span className={`seg seg-${c.segment}`}>{SEGMENT_TEXT[c.segment]}</span></td>
                      <td className="num">{c.orders}</td>
                      <td className="num">{rupeesShort(c.spendPaise)}</td>
                      <td className="num">{c.views}</td>
                      <td className="num">{c.cartAdds}</td>
                      <td className="small">{c.favourite || '—'}</td>
                      <td className="small">{ago(c.lastOrder)}</td>
                      <td><button type="button" className="btn btn-sm" onClick={() => setGiving(c)}>Give coupon</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="an-grid">
            <section className="box tile">
              <h2 className="tile-title">Most engaged <span className="muted small">(views + cart adds + searches)</span></h2>
              <table className="md-table">
                <thead><tr><th>Customer</th><th className="num">Views</th><th className="num">Cart adds</th><th className="num">Orders</th><th /></tr></thead>
                <tbody>
                  {engaged.map((c) => (
                    <tr key={c.email}>
                      <td><button type="button" className="link-btn cust-name" onClick={() => setViewing(c)}>{c.name}</button></td>
                      <td className="num">{c.views}</td><td className="num">{c.cartAdds}</td><td className="num">{c.orders}</td>
                      <td><button type="button" className="link-btn small" onClick={() => setGiving(c)}>Coupon</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="box tile">
              <h2 className="tile-title">Looked at vs bought <span className="muted small">(top products)</span></h2>
              <table className="md-table">
                <thead><tr><th>Product</th><th className="num">Viewers</th><th className="num">Cart adds</th><th className="num">Buyers</th><th className="num" title="Buyers ÷ people who viewed">Bought</th></tr></thead>
                <tbody>
                  {data.products.map((p) => (
                    <tr key={p.productId}>
                      <td><Link to={`/p/${p.productId}`}>{p.name}</Link></td>
                      <td className="num">{p.viewers}</td><td className="num">{p.cartAdds}</td><td className="num">{p.buyers}</td>
                      <td className="num">{p.viewers ? `${Math.min(100, Math.round((p.buyers / p.viewers) * 100))}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </>
      )}

      <div className="an-grid">
        <section className="box tile">
          <h2 className="tile-title">Coupons given <span className="muted small">({coupons.length})</span></h2>
          {coupons.length ? (
            <table className="md-table">
              <thead><tr><th>Code</th><th>Customer</th><th className="num">Off</th><th>Status</th><th /></tr></thead>
              <tbody>
                {coupons.slice(0, 12).map((c) => (
                  <tr key={c.code}>
                    <td className="mono">{c.code}</td>
                    <td className="small">{c.customerEmail}</td>
                    <td className="num">{c.percentOff}%</td>
                    <td className="small">
                      {c.redeemedOrderId ? <span className="seg seg-used">✓ Used {ago(c.redeemedAt)}</span>
                        : Date.parse(c.expiresAt) < Date.now() ? 'Expired' : `Open · ${Math.max(1, Math.ceil((Date.parse(c.expiresAt) - Date.now()) / 86_400_000))} days left`}
                    </td>
                    <td>{c.link && !c.redeemedOrderId && <CopyLink coupon={c} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted small">None yet. Pick a customer above and press “Give coupon”.</p>}
        </section>
        <section className="box tile">
          <h2 className="tile-title">Same product, different city prices <span className="muted small">(partner shops)</span></h2>
          <table className="md-table">
            <thead><tr><th>Product</th><th className="num">Ours</th><th className="num">Cheapest</th><th className="num">Dearest</th></tr></thead>
            <tbody>
              {spread.slice(0, 10).map((s) => (
                <tr key={s.productId}>
                  <td><Link to={`/p/${s.productId}`}>{s.name}</Link></td>
                  <td className="num">{inr(s.ownPricePaise)}</td>
                  <td className="num">{inr(s.minPaise)} <span className="muted small">{s.cheapestCity}</span></td>
                  <td className="num">{inr(s.maxPaise)} <span className="muted small">{s.dearestCity}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      {giving && (
        <GiveCoupon customer={giving} call={call} onClose={() => setGiving(null)}
          onIssued={(c) => { setCoupons((xs) => [c, ...xs]); }} />
      )}
      {viewing && (
        <CustomerDetail customer={viewing} days={days} demo={demo} call={call} onClose={() => setViewing(null)}
          onGive={() => { setGiving(viewing); setViewing(null); }} />
      )}
    </main>
  );
}

function CopyLink({ coupon }: { coupon: Coupon }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="link-btn small" title={fullLink(coupon)}
      onClick={() => { navigator.clipboard.writeText(fullLink(coupon)).then(() => setDone(true), () => {}); }}>
      {done ? 'Copied' : 'Copy link'}
    </button>
  );
}

/** Store console sub-navigation: stock & missed demand / customers. */
export function ConsoleTabs() {
  const path = typeof window !== 'undefined' ? window.location.pathname : '';
  return (
    <nav className="console-tabs" aria-label="Store console">
      <Link to="/ops" className={path === '/ops' ? 'on' : ''} aria-current={path === '/ops' ? 'page' : undefined}>Stock &amp; missed demand</Link>
      <Link to="/ops/customers" className={path === '/ops/customers' ? 'on' : ''} aria-current={path === '/ops/customers' ? 'page' : undefined}>Customers</Link>
    </nav>
  );
}

export function Tile({ title, value, note }: { title: string; value: string; note: string }) {
  return (
    <section className="tile box">
      <h3 className="tile-title">{title}</h3>
      <div className="big">{value}</div>
      <p className="muted small">{note}</p>
    </section>
  );
}

/** Revenue per day: one series, so no legend; orders and visitors live in the tooltip, not a second axis. */
export function RevenueChart({ daily }: { daily: Overview['daily'] }) {
  const [hover, setHover] = useState<number | null>(null);
  // Draw at the real pixel width (no viewBox stretching, so labels keep their shape).
  const wrapRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  if (!daily.length) return null;
  const H = 180, PAD_L = 0, PAD_B = 22, PAD_T = 10;
  const max = Math.max(...daily.map((d) => d.revenuePaise), 1);
  const slot = (W - PAD_L) / daily.length;
  const bw = Math.max(3, Math.min(16, slot - 4));
  const every = W < 520 ? 14 : 7;
  const y = (v: number) => PAD_T + (H - PAD_T - PAD_B) * (1 - v / max);
  const label = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const h = hover != null ? daily[hover] : null;
  return (
    <section className="box tile wide chart-tile">
      <h2 className="tile-title">Revenue per day <span className="muted small">peak {rupeesShort(max)}</span></h2>
      <div className="chart-wrap" ref={wrapRef} onMouseLeave={() => setHover(null)}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Revenue per day over ${daily.length} days, peak ${rupeesShort(max)}`}>
          <line x1={PAD_L} x2={W} y1={H - PAD_B} y2={H - PAD_B} className="axis" />
          {daily.map((d, i) => {
            const x = PAD_L + i * slot + (slot - bw) / 2;
            const top = y(d.revenuePaise);
            const hgt = Math.max(0, H - PAD_B - top);
            const r = Math.min(4, bw / 2, hgt);
            return (
              <g key={d.day}>
                {hgt > 0 && (
                  <path className={`bar ${hover === i ? 'on' : ''}`}
                    d={`M${x},${H - PAD_B} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${H - PAD_B} Z`} />
                )}
                {/* hit target: the whole column, bigger than the bar */}
                <rect x={PAD_L + i * slot} y={0} width={slot} height={H} fill="transparent"
                  onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}
                  aria-label={`${label(d.day)}: ${rupeesShort(d.revenuePaise)}, ${d.orders} orders, ${d.visitors} visitors`} />
                {(i === 0 || i === daily.length - 1 || (i % every === 0 && daily.length - 1 - i >= every / 2)) && (
                  <text x={i === 0 ? PAD_L : i === daily.length - 1 ? W : PAD_L + i * slot + slot / 2} y={H - 6}
                    textAnchor={i === 0 ? 'start' : i === daily.length - 1 ? 'end' : 'middle'} className="tick">{label(d.day)}</text>
                )}
              </g>
            );
          })}
        </svg>
        {h && hover != null && (
          <div className="chart-tip" style={{ left: `${((hover + 0.5) / daily.length) * 100}%` }}>
            <strong>{label(h.day)}</strong>
            <span>{rupeesShort(h.revenuePaise)} · {h.orders} order{h.orders === 1 ? '' : 's'}</span>
            {h.visitors > 0 && <span className="muted">{h.visitors} visitors</span>}
          </div>
        )}
      </div>
    </section>
  );
}

type Call = <T>(path: string, init?: RequestInit) => Promise<T>;

function GiveCoupon({ customer, call, onClose, onIssued }: { customer: Customer; call: Call; onClose: () => void; onIssued: (c: Coupon) => void }) {
  const [percent, setPercent] = useState(customer.suggestion.percent);
  const [daysValid, setDaysValid] = useState(7);
  const [reason, setReason] = useState(customer.suggestion.why);
  // The link opens the product they look at most (else buy most), in the city they order from most.
  const productChoices = [
    customer.viewedId && { id: customer.viewedId, label: `${customer.viewedName ?? 'Product'} (looks at most)` },
    customer.favouriteId && customer.favouriteId !== customer.viewedId && { id: customer.favouriteId, label: `${customer.favouriteName ?? 'Product'} (buys most)` },
  ].filter((x): x is { id: number; label: string } => Boolean(x));
  const [productId, setProductId] = useState<number | null>(productChoices[0]?.id ?? null);
  const [city, setCity] = useState<string>(customer.topCity ?? customer.cities[0] ?? 'BLR');
  const [issued, setIssued] = useState<Coupon | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const c = await call<Coupon>('/retailer/coupons', {
        method: 'POST',
        body: JSON.stringify({ email: customer.email, percentOff: percent, days: daysValid, reason, city, ...(productId ? { productId } : {}) }),
      });
      setIssued(c);
      onIssued(c);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const link = issued ? fullLink(issued) : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* ignore */ }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal cust-modal" role="dialog" aria-modal="true" aria-labelledby="gc-title" onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
        <button type="button" className="modal-x" aria-label="Close" onClick={onClose}>×</button>
        <h2 id="gc-title" className="cust-modal-title">Give {customer.name.split(' ')[0] || 'them'} a coupon</h2>
        <p className="muted small">
          {customer.email} · {customer.orders} orders · {rupeesShort(customer.spendPaise)} spent · {customer.views} product views
        </p>
        <p className="small"><span className={`seg seg-${customer.segment}`}>{SEGMENT_TEXT[customer.segment]}</span> {customer.suggestion.why}.</p>
        {issued ? (
          <div className="coupon-issued">
            <div className="coupon-code mono">{issued.code}</div>
            <p className="small">{issued.percentOff}% off one order, for {issued.customerEmail} only, until {new Date(issued.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}.</p>
            <a className="coupon-link small" href={link} target="_blank" rel="noreferrer">{link}</a>
            <button type="button" className="btn btn-primary btn-block" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</button>
            <p className="muted small">
              The link opens {productChoices.find((p) => p.id === issued.productId)?.label.replace(/ \(.*\)$/, '') ?? 'the shop'} in {cityName(issued.city ?? city)} with
              the code filled in. At checkout it only works with this email.
            </p>
          </div>
        ) : (
          <form className="form cust-form" onSubmit={submit}>
            <label>
              Discount
              <select value={percent} onChange={(e) => setPercent(Number(e.target.value))}>
                {[5, 10, 15, 20, 25, 30].map((p) => <option key={p} value={p}>{p}% off{p === customer.suggestion.percent ? ' (suggested)' : ''}</option>)}
              </select>
            </label>
            <label>
              Valid for
              <select value={daysValid} onChange={(e) => setDaysValid(Number(e.target.value))}>
                {[3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </label>
            {productChoices.length > 0 && (
              <label>
                Link opens
                <select value={productId ?? ''} onChange={(e) => setProductId(Number(e.target.value) || null)}>
                  {productChoices.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  <option value="">The shop (no product)</option>
                </select>
              </label>
            )}
            <label>
              In city
              <select value={city} onChange={(e) => setCity(e.target.value)}>
                {CITY_CODES.map((c) => (
                  <option key={c} value={c}>{cityName(c)}{c === customer.topCity ? ' (where they shop)' : ''}</option>
                ))}
              </select>
            </label>
            <label>
              Note <span className="muted small">(for you)</span>
              <input value={reason} maxLength={120} onChange={(e) => setReason(e.target.value)} />
            </label>
            {err && <p className="coupon-bad small" role="alert">{err}</p>}
            <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Creating…' : `Create ${percent}% coupon`}</button>
          </form>
        )}
      </div>
    </div>
  );
}

function CustomerDetail({ customer, days, demo, call, onClose, onGive }: {
  customer: Customer; days: number; demo: boolean; call: Call; onClose: () => void; onGive: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    call<Detail>(`/retailer/customers/${encodeURIComponent(customer.email)}?days=${days}&demo=${demo ? 1 : 0}`)
      .then(setD).catch((e) => setErr((e as Error).message));
  }, [call, customer.email, days, demo]);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal cust-modal wide" role="dialog" aria-modal="true" aria-labelledby="cd-title" onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
        <button type="button" className="modal-x" aria-label="Close" onClick={onClose}>×</button>
        <h2 id="cd-title" className="cust-modal-title">{customer.name}</h2>
        <p className="muted small">
          {customer.email} · shops in {customer.cities.map((c) => cityName(c)).join(', ') || '—'} · last seen {ago(customer.lastSeen ?? customer.lastOrder)}
        </p>
        {err && <p className="coupon-bad small">{err}</p>}
        {d && (
          <div className="cust-detail">
            <div>
              <h3 className="tile-title">Buys most</h3>
              <ul className="plain">{d.bought.map((b) => <li key={b.name}><span>{b.name}</span><span className="num">{b.units} × · {rupeesShort(b.spendPaise)}</span></li>)}</ul>
              <h3 className="tile-title">Looks at most</h3>
              <ul className="plain">{d.looked.length ? d.looked.map((l) => <li key={l.name}><span>{l.name}</span><span className="num">{l.views} views</span></li>) : <li className="muted">No browsing linked yet</li>}</ul>
            </div>
            <div>
              <h3 className="tile-title">Recent orders</h3>
              <ul className="plain">
                {d.orders.slice(0, 8).map((o) => (
                  <li key={o.orderNumber}>
                    <span className="mono small">{o.orderNumber}</span>
                    <span className="num">{rupeesShort(o.totalPaise)}{o.coupon && <span className="muted small"> · {o.coupon}</span>}</span>
                  </li>
                ))}
              </ul>
              {d.coupons.length > 0 && (
                <p className="small">Coupons: {d.coupons.map((c) => `${c.code} (${c.redeemedOrderId ? 'used' : 'open'})`).join(', ')}</p>
              )}
            </div>
          </div>
        )}
        <button type="button" className="btn btn-primary" onClick={onGive}>Give {customer.name.split(' ')[0]} a coupon</button>
      </div>
    </div>
  );
}
