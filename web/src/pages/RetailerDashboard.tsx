import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, inr, post } from '../api';
import { useAccount } from '../state';
import { RevenueChart, Tile, ago, fmt, rupeesShort } from './Customers';
import { LiveNow, useShopLive } from '../components/LiveNow';

/**
 * A retailer's own dashboard (doc/18). The shop owner signs in with the shop's email (passwordless,
 * doc/17) and sees only their shop: sales, their customers (who buys most), how their items are looked
 * at in their city, their last units, and coupons that work only for one customer, only at their shop.
 * Numbers from Aiven for ClickHouse; shelf and coupons from PostgreSQL. Refreshes every 15 s.
 */

type Segment = 'vip' | 'lapsed' | 'new' | 'regular';
interface Customer {
  ref: string; email: string; name: string; orders: number; spendPaise: number; units: number; lastOrder: string | null;
  couponsUsed: number; live: boolean; views: number; cartAdds: number; lastSeen: string | null; segment: Segment;
  suggestion: { label: string; percent: number; why: string }; canGetCoupon: boolean;
  favouriteId: number | null; favouriteName: string | null; viewedId: number | null; viewedName: string | null;
}
interface Coupon {
  code: string; customerEmail: string; percentOff: number; reason: string; expiresAt: string; createdAt: string;
  redeemedOrderId: string | null; redeemedAt: string | null; productId: number | null; city: string | null; link: string | null;
}
interface ShelfItem { productId: number; name: string; category: string; pricePaise: number; qty: number; updatedAt: string }
interface ShopView {
  shop: { id: number; name: string; city: string; cityName: string; rating: number; deliveryNote: string };
  windowDays: number; maxPercent: number; couponMinOrders: number;
  stock: { products: number; units: number; lastUnits: number; soldOut: number; items: ShelfItem[] };
  coupons: Coupon[];
  clickhouse: { queries: number; ms: number; rowsRead: number } | null;
  totals?: {
    orders: number; customers: number; revenuePaise: number; discountPaise: number; couponOrders: number;
    views: number; viewers: number; liveViewers: number; repeatCustomers: number;
  };
  customers?: Customer[];
  daily?: { day: string; orders: number; revenuePaise: number; visitors: number }[];
  products?: { productId: number; name: string; views: number; viewers: number; units: number; revenuePaise: number; buyers: number; qty: number }[];
  recent?: { orderNumber: string; at: string | null; customer: string; totalPaise: number; discountPaise: number; coupon: string; demo: boolean; product: string; qty: number }[];
}
interface Detail {
  email: string;
  orders: { orderNumber: string; at: string | null; totalPaise: number; discountPaise: number; coupon: string; demo: boolean; product: string; qty: number }[];
  looked: { name: string; views: number }[];
  coupons: Coupon[];
}

const SEGMENT_TEXT: Record<Segment, string> = { vip: 'Top customer', lapsed: 'Gone quiet', new: 'Bought once', regular: 'Regular' };
const fullLink = (c: Pick<Coupon, 'link'>) => (c.link ? `${window.location.origin}${c.link}` : '');
const when = (iso: string | null) => {
  if (!iso) return '—';
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.floor(m / 60)} h ago` : ago(iso);
};
const couponStatus = (c: Coupon) =>
  c.redeemedOrderId ? <span className="seg seg-used">✓ Used {ago(c.redeemedAt)}</span>
    : Date.parse(c.expiresAt) < Date.now() ? 'Expired'
    : `Open · ${Math.max(1, Math.ceil((Date.parse(c.expiresAt) - Date.now()) / 86_400_000))} days left`;

export function RetailerDashboard() {
  const { account, retailer } = useAccount();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<ShopView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [giving, setGiving] = useState<Customer | null>(null);
  const [viewing, setViewing] = useState<Customer | null>(null);
  // "Live now": presence every 2 s (Valkey), separate from the 15 s ClickHouse refresh below.
  const live = useShopLive(Boolean(retailer));
  const liveIds = new Map((live?.products ?? []).map((p) => [p.productId, p]));

  const load = useCallback(async () => {
    try {
      setData(await api<ShopView>(`/retailer/shop?days=${days}`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load your dashboard.');
    }
  }, [days]);
  useEffect(() => {
    if (!retailer) return;
    void load();
    // Live: a sale or a shopper looking shows up within seconds (Kafka → ClickHouse).
    const t = window.setInterval(() => document.visibilityState === 'visible' && void load(), 15_000);
    return () => window.clearInterval(t);
  }, [retailer, load]);

  if (account === undefined) return <main className="shell page"><p className="muted">Loading…</p></main>;
  if (!account || !retailer) {
    return (
      <main className="shell page ops">
        <h1 className="page-title">Your shop on StockHop</h1>
        <div className="box tile token-form">
          {account ? (
            <p>
              You’re signed in as <strong>{account.email}</strong>, which doesn’t run a shop. Sign out and sign in with your shop’s email.
            </p>
          ) : (
            <>
              <p>Retailers: sign in with your shop’s email to see who buys from you, what they look at, your last units, and give your regulars a coupon.</p>
              <Link className="btn btn-primary" to="/signin?next=/retailer">Sign in as a retailer</Link>
            </>
          )}
        </div>
      </main>
    );
  }

  const t = data?.totals;
  const lastUnits = data?.stock.items.filter((i) => i.qty <= 1) ?? [];
  return (
    <main className="shell page ops cust shop-dash">
      <div className="ops-head">
        <div>
          <h1 className="page-title">{retailer.name}</h1>
          <p className="muted small shop-sub">{retailer.cityName} · ★ {retailer.rating.toFixed(1)} · {retailer.deliveryNote}</p>
        </div>
        <div className="shop-pills">
          {(live || t) && (
            <span className={`live-pill ${(live?.shoppers ?? t?.liveViewers) ? '' : 'idle'}`} title="Shoppers on your items’ pages or hovering over them right now (updates every 2 s)">
              <span className="dot" />{live?.shoppers ?? t?.liveViewers ?? 0} looking at your items now
            </span>
          )}
          {data?.clickhouse && (
            <span className="live-pill ch-pill" title="Aiven for ClickHouse: your orders and every product view, streamed from Kafka">
              ClickHouse · {data.clickhouse.queries} queries · {Math.round(data.clickhouse.ms)} ms
            </span>
          )}
        </div>
      </div>

      <div className="cust-controls">
        <label className="toggle">
          Last
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>
        <span className="muted small">“Live now” updates every 2 s; sales and history every 15 s. Demo history is marked “demo”.</span>
      </div>

      {error && <div className="notice error" role="alert">{error}</div>}
      {!data && !error && <p className="muted">Loading your shop…</p>}

      {data && (
        <>
          <div className="ops-grid">
            {t && <Tile title="Sales" value={rupeesShort(t.revenuePaise)} note={`${fmt.format(t.orders)} orders · avg ${t.orders ? rupeesShort(t.revenuePaise / t.orders) : '—'}`} />}
            {t && <Tile title="Customers" value={fmt.format(t.customers)} note={`${t.repeatCustomers} came back for more`} />}
            {t && <Tile title={`Looked at in ${retailer.cityName}`} value={fmt.format(t.viewers)} note={`${fmt.format(t.views)} views of items you sell`} />}
            <Tile title="Last units" value={fmt.format(data.stock.lastUnits)} note={`${data.stock.soldOut} sold out · ${data.stock.products} items on your shelf`} />
            {t && <Tile title="Coupon orders" value={fmt.format(t.couponOrders)} note={t.discountPaise ? `${inr(t.discountPaise)} given as discounts` : 'none redeemed yet'} />}
          </div>

          <LiveNow data={live} city={retailer.city} cityName={retailer.cityName} />

          {data.daily && <RevenueChart daily={data.daily} />}

          {data.customers && (
            <section className="box tile wide">
              <h2 className="tile-title">
                Your customers, by spend <span className="muted small">(coupons are for regulars: {data.couponMinOrders}+ orders with you)</span>
              </h2>
              <div className="table-scroll">
                <table className="md-table cust-table">
                  <thead>
                    <tr>
                      <th>Customer</th><th>Type</th><th className="num">Orders</th><th className="num">Spent</th>
                      <th className="num" title="Views of your items">Looks</th><th>Buys most</th><th>Last order</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.customers.slice(0, 20).map((c) => (
                      <tr key={c.ref}>
                        <td>
                          <button type="button" className="link-btn cust-name" onClick={() => setViewing(c)}>{c.name || c.email}</button>
                          <div className="muted small">{c.email}{!c.live && ' · demo'}</div>
                        </td>
                        <td><span className={`seg seg-${c.segment}`}>{SEGMENT_TEXT[c.segment]}</span></td>
                        <td className="num">{c.orders}</td>
                        <td className="num">{rupeesShort(c.spendPaise)}</td>
                        <td className="num">{c.views}</td>
                        <td className="small">{c.favouriteName ?? '—'}</td>
                        <td className="small">{when(c.lastOrder)}</td>
                        <td>
                          {c.canGetCoupon
                            ? <button type="button" className="btn btn-sm" onClick={() => setGiving(c)}>Give coupon</button>
                            : <span className="muted small" title="Coupons are for repeat customers">after {data.couponMinOrders}nd order</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <div className="an-grid">
            {data.recent && (
              <section className="box tile">
                <h2 className="tile-title">Latest orders</h2>
                <ul className="plain">
                  {data.recent.map((o) => (
                    <li key={o.orderNumber}>
                      <span>
                        <strong>{o.customer}</strong> · {o.qty > 1 ? `${o.qty} × ` : ''}{o.product}
                        <br /><span className="muted small mono">{o.orderNumber}{o.demo ? ' · demo' : ''}{o.coupon ? ` · ${o.coupon}` : ''}</span>
                      </span>
                      <span className="num">{rupeesShort(o.totalPaise)}<br /><span className="muted small">{when(o.at)}</span></span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="box tile">
              <h2 className="tile-title">Last units on your shelf <span className="muted small">({lastUnits.length})</span></h2>
              <p className="muted small">One left means two shoppers can race for it: StockHop gives it to exactly one.</p>
              <ul className="plain shelf-list">
                {lastUnits.slice(0, 14).map((i) => (
                  <li key={i.productId}>
                    <Link to={`/p/${i.productId}?city=${retailer.city}`}>{i.name}</Link>
                    <span className="num">{inr(i.pricePaise)} <span className={`qty-badge ${i.qty === 0 ? 'out' : 'one'}`}>{i.qty === 0 ? 'Sold out' : '1 left'}</span></span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          {data.products && (
            <section className="box tile wide">
              <h2 className="tile-title">Your items: looked at vs bought <span className="muted small">(shoppers in {retailer.cityName})</span></h2>
              <div className="table-scroll">
                <table className="md-table">
                  <thead>
                    <tr><th>Item</th><th className="num">Viewers</th><th className="num">Buyers</th><th className="num">Sold</th><th className="num">Sales</th><th className="num">On shelf</th></tr>
                  </thead>
                  <tbody>
                    {data.products.map((p) => (
                      <tr key={p.productId}>
                        <td>
                          <Link to={`/p/${p.productId}?city=${retailer.city}`}>{p.name}</Link>
                          {liveIds.has(p.productId) && <span className="live-tag" title="Someone is looking at it right now">● live</span>}
                        </td>
                        <td className="num">{p.viewers}</td><td className="num">{p.buyers}</td><td className="num">{p.units}</td>
                        <td className="num">{rupeesShort(p.revenuePaise)}</td>
                        <td className="num">{p.qty === 0 ? <span className="qty-badge out">0</span> : p.qty === 1 ? <span className="qty-badge one">1</span> : p.qty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="box tile wide">
            <h2 className="tile-title">Coupons you gave <span className="muted small">({data.coupons.length})</span></h2>
            {data.coupons.length ? (
              <table className="md-table">
                <thead><tr><th>Code</th><th>For</th><th className="num">Off</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {data.coupons.slice(0, 12).map((c) => (
                    <tr key={c.code}>
                      <td className="mono">{c.code}</td>
                      <td className="small">{c.customerEmail}</td>
                      <td className="num">{c.percentOff}%</td>
                      <td className="small">{couponStatus(c)}</td>
                      <td>{c.link && !c.redeemedOrderId && <CopyLink coupon={c} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="muted small">None yet. Pick a regular above and press “Give coupon”.</p>}
          </section>
        </>
      )}

      {giving && data && (
        <GiveCoupon customer={giving} shopName={retailer.name} shelf={data.stock.items} maxPercent={data.maxPercent}
          onClose={() => setGiving(null)} onIssued={() => void load()} />
      )}
      {viewing && (
        <CustomerDetail customer={viewing} days={days} canGive={viewing.canGetCoupon} onClose={() => setViewing(null)}
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

function GiveCoupon({ customer, shopName, shelf, maxPercent, onClose, onIssued }: {
  customer: Customer; shopName: string; shelf: ShelfItem[]; maxPercent: number; onClose: () => void; onIssued: () => void;
}) {
  const [percent, setPercent] = useState(customer.suggestion.percent);
  const [daysValid, setDaysValid] = useState(7);
  const [reason, setReason] = useState(customer.suggestion.why);
  // The link opens the item they look at most (else buy most) at this shop, in this shop's city.
  const choices = [
    customer.viewedId && { id: customer.viewedId, label: `${customer.viewedName ?? 'Item'} (looks at most)` },
    customer.favouriteId && customer.favouriteId !== customer.viewedId && { id: customer.favouriteId, label: `${customer.favouriteName ?? 'Item'} (buys most)` },
  ].filter((x): x is { id: number; label: string } => Boolean(x));
  const [productId, setProductId] = useState<number | null>(choices[0]?.id ?? null);
  const [issued, setIssued] = useState<Coupon | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const first = customer.name.split(' ')[0] || 'them';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const c = await post<Coupon>('/retailer/shop/coupons', {
        ref: customer.ref, percentOff: percent, days: daysValid, reason, ...(productId ? { productId } : {}),
      });
      setIssued(c);
      onIssued();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const link = issued ? fullLink(issued) : '';
  const itemName = (id: number | null) => shelf.find((s) => s.productId === id)?.name;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal cust-modal" role="dialog" aria-modal="true" aria-labelledby="sgc-title" onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
        <button type="button" className="modal-x" aria-label="Close" onClick={onClose}>×</button>
        <h2 id="sgc-title" className="cust-modal-title">Give {first} a coupon</h2>
        <p className="muted small">
          {customer.email} · {customer.orders} orders with you · {rupeesShort(customer.spendPaise)} spent · {customer.views} looks at your items
        </p>
        <p className="small"><span className={`seg seg-${customer.segment}`}>{SEGMENT_TEXT[customer.segment]}</span> {customer.suggestion.why}.</p>
        {issued ? (
          <div className="coupon-issued">
            <div className="coupon-code mono">{issued.code}</div>
            <p className="small">
              {issued.percentOff}% off, until {new Date(issued.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}.
              {' '}Only <strong>{issued.customerEmail}</strong> can use it, signed in, and only when buying from {shopName}.
            </p>
            <a className="coupon-link small" href={link} target="_blank" rel="noreferrer">{link}</a>
            <button type="button" className="btn btn-primary btn-block" onClick={() => { navigator.clipboard.writeText(link).then(() => setCopied(true), () => {}); }}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <p className="muted small">The link opens {itemName(issued.productId) ?? 'StockHop'} with the code filled in.</p>
          </div>
        ) : (
          <form className="form cust-form" onSubmit={submit}>
            <label>
              Discount
              <select value={percent} onChange={(e) => setPercent(Number(e.target.value))}>
                {[5, 10, 15, 20, 25, 30].filter((p) => p <= maxPercent).map((p) => (
                  <option key={p} value={p}>{p}% off{p === customer.suggestion.percent ? ' (suggested)' : ''}</option>
                ))}
              </select>
            </label>
            <label>
              Valid for
              <select value={daysValid} onChange={(e) => setDaysValid(Number(e.target.value))}>
                {[3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} days</option>)}
              </select>
            </label>
            <label>
              Link opens
              <select value={productId ?? ''} onChange={(e) => setProductId(Number(e.target.value) || null)}>
                {choices.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                {shelf.filter((s) => !choices.some((c) => c.id === s.productId)).slice(0, 40).map((s) => (
                  <option key={s.productId} value={s.productId}>{s.name}</option>
                ))}
                <option value="">StockHop home (no item)</option>
              </select>
            </label>
            <label>
              Note <span className="muted small">(for you)</span>
              <input value={reason} maxLength={120} onChange={(e) => setReason(e.target.value)} />
            </label>
            {err && <p className="coupon-bad small" role="alert">{err}</p>}
            <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Creating…' : `Create ${percent}% coupon for ${first}`}</button>
            <p className="muted small">Works only for {customer.email} (signed in), only at {shopName}, once.</p>
          </form>
        )}
      </div>
    </div>
  );
}

function CustomerDetail({ customer, days, canGive, onClose, onGive }: {
  customer: Customer; days: number; canGive: boolean; onClose: () => void; onGive: () => void;
}) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api<Detail>(`/retailer/shop/customers/${customer.ref}?days=${Math.max(days, 90)}`)
      .then(setD).catch((e) => setErr((e as Error).message));
  }, [customer.ref, days]);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal cust-modal wide" role="dialog" aria-modal="true" aria-labelledby="scd-title" onClick={(e) => e.stopPropagation()} style={{ position: 'relative' }}>
        <button type="button" className="modal-x" aria-label="Close" onClick={onClose}>×</button>
        <h2 id="scd-title" className="cust-modal-title">{customer.name}</h2>
        <p className="muted small">{customer.email} · first order {when(d?.orders.at(-1)?.at ?? null)} · last order {when(customer.lastOrder)}</p>
        {err && <p className="coupon-bad small">{err}</p>}
        {d && (
          <div className="cust-detail">
            <div>
              <h3 className="tile-title">Orders with you</h3>
              <ul className="plain">
                {d.orders.slice(0, 10).map((o) => (
                  <li key={o.orderNumber}>
                    <span>{o.product}<br /><span className="muted small mono">{o.orderNumber}{o.coupon ? ` · ${o.coupon}` : ''}</span></span>
                    <span className="num">{rupeesShort(o.totalPaise)}<br /><span className="muted small">{when(o.at)}</span></span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="tile-title">Looks at most (your items)</h3>
              <ul className="plain">{d.looked.length ? d.looked.map((l) => <li key={l.name}><span>{l.name}</span><span className="num">{l.views} views</span></li>) : <li className="muted">No browsing linked yet</li>}</ul>
              {d.coupons.length > 0 && (
                <p className="small">Your coupons for them: {d.coupons.map((c) => `${c.code} (${c.redeemedOrderId ? 'used' : 'open'})`).join(', ')}</p>
              )}
            </div>
          </div>
        )}
        {canGive
          ? <button type="button" className="btn btn-primary" onClick={onGive}>Give {customer.name.split(' ')[0]} a coupon</button>
          : <p className="muted small">Coupons are for repeat customers: {customer.name.split(' ')[0]} has {customer.orders} order with you.</p>}
      </div>
    </div>
  );
}
