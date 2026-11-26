import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { env } from '../config.js';
import { getPool } from '../lib/db.js';
import { HttpError, parse } from '../lib/http.js';
import { maskEmail } from '../lib/log.js';
import { chEnabled, chSelect, ensureSchema } from '../lib/clickhouse.js';
import { issueCoupon, listCoupons } from '../domain/coupons.js';
import { currentAccount } from '../domain/accounts.js';
import { listShops, shopById, shopForEmail, type Shop } from '../domain/retailers.js';
import { livePresence } from '../lib/presence.js';

/**
 * One retailer's own dashboard (doc/18): only that shop's sales, its customers, how its products are
 * looked at in its city, its last units, and coupons that only work at that shop.
 *
 * Who may open it: the shop's owner, signed in (doc/17), or the store admin (token + ?seller=).
 * Reads ClickHouse (order_lines.seller_id, activity) and PostgreSQL (the shop's shelf and coupons).
 */
export const shopDashboard = Router();

/*
 * Privacy: a shop sees its own customers, but a real (non-demo) customer's email and surname are
 * masked, and the browser refers to customers by an opaque ref, never by email. Demo retailer logins
 * are shared for the pitch, so nothing real should be readable through them. Demo people (example.com
 * / example.org) are shown in full.
 */
const isDemo = (email: string) => /@example.(com|org)$/i.test(email);
const showEmail = (email: string) => (isDemo(email) ? email : maskEmail(email));
const showName = (name: string, email: string) => {
  if (isDemo(email)) return name;
  const [first = '', ...rest] = name.trim().split(/s+/);
  return rest.length ? `${first} ${rest.at(-1)!.charAt(0)}.` : first;
};
const refFor = (shopId: number, email: string) =>
  createHash('sha256').update(`shopref:${env.AUTH_SECRET ?? env.ADMIN_TOKEN ?? 'stockhop'}:${shopId}:${email}`).digest('hex').slice(0, 24);

/** ref → email, among this shop's own customers only. */
async function emailForRef(shop: Shop, ref: string): Promise<string> {
  let emails: string[];
  if (chEnabled()) {
    await ensureSchema();
    emails = (await chSelect<{ e: string }>(
      `SELECT DISTINCT customer_email AS e FROM order_lines FINAL WHERE ${SELLER_MATCH}`, { seller: shop.id, sellerName: shop.name },
    )).rows.map((r) => r.e);
  } else {
    emails = (await getPool().query<{ e: string }>(
      `SELECT DISTINCT c.email AS e FROM orders o JOIN customers c ON c.id = o.customer_id
         JOIN order_items i ON i.order_id = o.id WHERE i.seller_id = $1`, [shop.id],
    )).rows.map((r) => r.e);
  }
  const email = emails.find((e) => refFor(shop.id, e) === ref);
  if (!email) throw new HttpError(404, 'NOT_FOUND', 'Not one of your customers.');
  return email;
}
/** A shop's coupons, with real customers' emails masked. */
const shopCoupons = async (shopId: number) =>
  (await listCoupons(100, shopId)).map((c) => ({ ...c, customerEmail: showEmail(c.customerEmail) }));

async function requireShop(req: Request): Promise<Shop> {
  if (env.ADMIN_TOKEN && req.get('x-admin-token') === env.ADMIN_TOKEN) {
    const id = Number(req.query.seller ?? req.body?.seller);
    const s = id ? await shopById(id) : null;
    if (!s) throw new HttpError(400, 'VALIDATION', 'Pick a shop (?seller=).');
    return s;
  }
  const acct = await currentAccount(req);
  if (!acct) throw new HttpError(401, 'SIGN_IN_REQUIRED', 'Sign in with your shop’s email to see your dashboard.');
  const s = await shopForEmail(acct.email);
  if (!s) throw new HttpError(401, 'UNAUTHORIZED', `${acct.email} doesn’t run a shop on StockHop.`);
  return s;
}

const Window = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  demo: z.enum(['0', '1']).default('1'),
});
const WHERE = `at >= now() - INTERVAL {days:UInt16} DAY AND ({demo:UInt8} = 1 OR source = 'live')`;
/**
 * Lines this shop sold. Matches by name too when seller_id is 0: an event handled by a worker older
 * than seller_id (e.g. during a redeploy) still counts for the shop.
 */
const SELLER_MATCH = `(seller_id = {seller:UInt32} OR (seller_id = 0 AND seller = {sellerName:String}))`;
/** This shop's orders: every order with a line it sold (shop purchases are one item each). */
const SHOP_ORDERS = `SELECT * FROM orders FINAL WHERE ${WHERE}
  AND order_id IN (SELECT order_id FROM order_lines FINAL WHERE ${SELLER_MATCH})`;
/** Product pages of the shop's items, opened by shoppers in the shop's city. */
const SHOP_VIEWS = `SELECT visitor, product_id, at, type, label FROM activity FINAL WHERE ${WHERE}
  AND city = {city:String} AND product_id > 0 AND has({products:Array(UInt32)}, product_id)`;

/** A shop's coupons are for its own regulars: customers with at least this many orders there. */
export const COUPON_MIN_ORDERS = 2;

/** How many orders this email has placed with this shop (ClickHouse, else PostgreSQL). */
async function ordersAtShop(shop: Shop, email: string): Promise<number> {
  if (chEnabled()) {
    await ensureSchema();
    const r = await chSelect<{ n: string }>(
      `SELECT uniqExact(order_id) AS n FROM order_lines FINAL WHERE ${SELLER_MATCH} AND customer_email = {email:String}`,
      { seller: shop.id, sellerName: shop.name, email },
    );
    return Number(r.rows[0]?.n ?? 0);
  }
  const r = await getPool().query<{ n: number }>(
    `SELECT count(DISTINCT o.id)::int AS n FROM orders o JOIN customers c ON c.id = o.customer_id
       JOIN order_items i ON i.order_id = o.id
      WHERE i.seller_id = $1 AND c.email = lower($2) AND o.status = 'confirmed'`,
    [shop.id, email],
  );
  return r.rows[0]?.n ?? 0;
}

const n = (v: unknown) => Number(v ?? 0);
const iso = (v: unknown) => {
  const s = String(v ?? '');
  return !s || s.startsWith('1970') ? null : `${s.replace(' ', 'T')}Z`;
};

type Segment = 'vip' | 'lapsed' | 'new' | 'regular';
const SUGGEST: Record<Segment, { label: string; percent: number; why: string }> = {
  vip: { label: 'Your top customer', percent: 10, why: 'Thank-you for being one of our best customers' },
  lapsed: { label: 'Gone quiet', percent: 20, why: 'We miss you: come back to us' },
  new: { label: 'Bought once', percent: 10, why: 'Welcome back for a second order' },
  regular: { label: 'Regular', percent: 5, why: 'Small thank-you' },
};

async function shelf(shop: Shop) {
  const { rows } = await getPool().query<{ product_id: number; name: string; category: string; price_paise: number; qty: number; updated_at: Date }>(
    `SELECT o.product_id, p.name, p.category, o.price_paise, o.qty, o.updated_at
       FROM seller_offers o JOIN products p ON p.id = o.product_id
      WHERE o.seller_id = $1 ORDER BY o.qty, p.name`,
    [shop.id],
  );
  return rows;
}

shopDashboard.get('/retailer/shops', async (req, res) => {
  if (!env.ADMIN_TOKEN || req.get('x-admin-token') !== env.ADMIN_TOKEN) throw new HttpError(401, 'UNAUTHORIZED', 'Store admin token required');
  res.json({ items: await listShops() });
});

shopDashboard.get('/retailer/shop', async (req, res) => {
  const shop = await requireShop(req);
  const w = parse(Window, req.query);
  const items = await shelf(shop);
  const names = new Map(items.map((i) => [i.product_id, i.name]));
  const coupons = await shopCoupons(shop.id);
  const base = {
    shop,
    windowDays: w.days,
    stock: {
      products: items.length,
      units: items.reduce((s, i) => s + i.qty, 0),
      lastUnits: items.filter((i) => i.qty === 1).length,
      soldOut: items.filter((i) => i.qty === 0).length,
      items: items.map((i) => ({ productId: i.product_id, name: i.name, category: i.category, pricePaise: i.price_paise, qty: i.qty, updatedAt: i.updated_at.toISOString() })),
    },
    coupons,
    maxPercent: env.COUPON_PERCENT_MAX,
    couponMinOrders: COUPON_MIN_ORDERS,
  };
  res.set('Cache-Control', 'no-store');
  if (!chEnabled()) {
    res.json({ ...base, clickhouse: null });
    return;
  }
  await ensureSchema();
  const params = { days: w.days, demo: Number(w.demo), seller: shop.id, sellerName: shop.name, city: shop.city, products: JSON.stringify(items.map((i) => i.product_id)) };

  const [totals, buyers, viewers, daily, products, recent] = await Promise.all([
    chSelect<Record<string, string>>(
      `SELECT
         (SELECT count() FROM (${SHOP_ORDERS})) AS orders,
         (SELECT uniqExact(customer_email) FROM (${SHOP_ORDERS})) AS customers,
         (SELECT sum(total_paise) FROM (${SHOP_ORDERS})) AS revenue,
         (SELECT sum(discount_paise) FROM (${SHOP_ORDERS})) AS discounts,
         (SELECT countIf(coupon != '') FROM (${SHOP_ORDERS})) AS coupon_orders,
         (SELECT countIf(type = 'page_view') FROM (${SHOP_VIEWS})) AS views,
         (SELECT uniqExactIf(visitor, type = 'page_view') FROM (${SHOP_VIEWS})) AS viewers,
         (SELECT uniqExact(visitor) FROM activity FINAL WHERE at >= now() - INTERVAL 45 SECOND
            AND type = 'product_presence' AND city = {city:String}
            AND has({products:Array(UInt32)}, product_id)) AS live_viewers`,
      params,
    ),
    // Everyone who bought from this shop: how much, how often, what they buy most.
    chSelect<Record<string, unknown>>(
      `WITH so AS (${SHOP_ORDERS}),
         f AS (SELECT customer_email, topKWeighted(1)(product_id, toUInt64(qty))[1] AS fav_id
                 FROM order_lines FINAL WHERE ${WHERE} AND ${SELLER_MATCH} GROUP BY customer_email)
       SELECT so.customer_email AS email, argMax(so.customer_name, so.at) AS name, count() AS orders,
              sum(so.total_paise) AS spend, sum(so.items) AS units, max(so.at) AS last_order, min(so.at) AS first_order,
              countIf(so.coupon != '') AS coupons_used, countIf(so.source = 'live') AS live_orders, any(f.fav_id) AS fav_id
         FROM so LEFT JOIN f ON f.customer_email = so.customer_email
        GROUP BY email ORDER BY spend DESC LIMIT 200`,
      params,
    ),
    // Known shoppers (linked to an email through their own orders) looking at this shop's products.
    chSelect<Record<string, unknown>>(
      `WITH m AS (SELECT customer_email, visitor, argMax(customer_name, at) AS name FROM orders FINAL
                   WHERE visitor != '' GROUP BY customer_email, visitor),
            pv AS (${SHOP_VIEWS})
       SELECT m.customer_email AS email, any(m.name) AS name, countIf(pv.type = 'page_view') AS views,
              countIf(pv.type = 'click' AND pv.label = 'add-to-cart') AS cart_adds,
              topKIf(1)(pv.product_id, pv.type = 'page_view')[1] AS viewed_id, max(pv.at) AS last_seen
         FROM m INNER JOIN pv ON pv.visitor = m.visitor
        GROUP BY email ORDER BY views DESC LIMIT 200`,
      params,
    ),
    chSelect<Record<string, string>>(
      `SELECT toDate(at) AS d, count() AS orders, sum(total_paise) AS revenue FROM (${SHOP_ORDERS}) GROUP BY d ORDER BY d`,
      params,
    ),
    chSelect<Record<string, string>>(
      `SELECT product_id, sum(views) AS views, sum(viewers) AS viewers, sum(units) AS units, sum(revenue) AS revenue, sum(buyers) AS buyers FROM (
         SELECT product_id, countIf(type = 'page_view') AS views, uniqExactIf(visitor, type = 'page_view') AS viewers,
                0 AS units, 0 AS revenue, 0 AS buyers
           FROM (${SHOP_VIEWS}) GROUP BY product_id
         UNION ALL
         SELECT product_id, 0, 0, sum(qty), sum(qty * unit_price_paise), uniqExact(customer_email)
           FROM order_lines FINAL WHERE ${WHERE} AND ${SELLER_MATCH} GROUP BY product_id)
       GROUP BY product_id ORDER BY revenue DESC, views DESC LIMIT 15`,
      params,
    ),
    chSelect<Record<string, string>>(
      `SELECT o.order_number AS order_number, o.at AS at, o.customer_name AS customer, o.customer_email AS email,
              o.total_paise AS total, o.discount_paise AS discount, o.coupon AS coupon, o.source AS source,
              l.product_id AS product_id, l.qty AS qty
         FROM (${SHOP_ORDERS}) AS o
         INNER JOIN (SELECT order_id, product_id, qty FROM order_lines FINAL WHERE ${SELLER_MATCH}) AS l
           ON l.order_id = o.order_id
        ORDER BY o.at DESC LIMIT 12`,
      params,
    ),
  ]);

  // One row per customer of THIS shop. People who only looked stay anonymous to the shop (privacy):
  // they show up as counts in "products", never by name.
  const seen = new Map(viewers.rows.map((v) => [String(v.email), v]));
  const DAY = 86_400_000;
  const bought = buyers.rows.map((r) => {
    const v = seen.get(String(r.email));
    return {
      email: String(r.email), name: String(r.name), orders: n(r.orders), spendPaise: n(r.spend), units: n(r.units),
      lastOrder: iso(r.last_order), firstOrder: iso(r.first_order), couponsUsed: n(r.coupons_used), live: n(r.live_orders) > 0,
      favouriteId: n(r.fav_id) || null, views: n(v?.views), cartAdds: n(v?.cart_adds), viewedId: n(v?.viewed_id) || null,
      lastSeen: iso(v?.last_seen),
    };
  });
  const spends = bought.map((b) => b.spendPaise).sort((a, b) => b - a);
  const vipLine = spends[Math.max(0, Math.ceil(spends.length * 0.1) - 1)] ?? Infinity;
  const customers = bought.map((c) => {
    const quiet = c.lastOrder ? (Date.now() - Date.parse(c.lastOrder)) / DAY : 0;
    const segment: Segment =
      c.orders >= 2 && c.spendPaise >= vipLine ? 'vip'
      : c.orders >= 2 && quiet > 14 ? 'lapsed'
      : c.orders === 1 ? 'new'
      : 'regular';
    return {
      ...c, email: showEmail(c.email), name: showName(c.name, c.email), ref: refFor(shop.id, c.email),
      segment, suggestion: SUGGEST[segment], canGetCoupon: c.orders >= COUPON_MIN_ORDERS,
      favouriteName: c.favouriteId ? names.get(c.favouriteId) ?? null : null,
      viewedName: c.viewedId ? names.get(c.viewedId) ?? null : null,
    };
  });

  const t = totals.rows[0] ?? {};
  const all = [totals, buyers, viewers, daily, products, recent];
  res.json({
    ...base,
    totals: {
      orders: n(t.orders), customers: n(t.customers), revenuePaise: n(t.revenue), discountPaise: n(t.discounts),
      couponOrders: n(t.coupon_orders), views: n(t.views), viewers: n(t.viewers), liveViewers: n(t.live_viewers),
      repeatCustomers: bought.filter((b) => b.orders >= 2).length,
    },
    customers,
    daily: daily.rows.map((d) => ({ day: d.d, orders: n(d.orders), revenuePaise: n(d.revenue), visitors: 0 })),
    products: products.rows.map((p) => ({
      productId: n(p.product_id), name: names.get(n(p.product_id)) ?? `#${p.product_id}`, views: n(p.views),
      viewers: n(p.viewers), units: n(p.units), revenuePaise: n(p.revenue), buyers: n(p.buyers),
      qty: items.find((i) => i.product_id === n(p.product_id))?.qty ?? 0,
    })),
    recent: recent.rows.map((r) => ({
      orderNumber: r.order_number, at: iso(r.at), customer: showName(r.customer ?? '', r.email ?? ''), totalPaise: n(r.total),
      discountPaise: n(r.discount), coupon: r.coupon, demo: r.source === 'demo',
      product: names.get(n(r.product_id)) ?? `#${r.product_id}`, qty: n(r.qty),
    })),
    clickhouse: {
      queries: all.length,
      ms: Math.round(all.reduce((s, q) => s + q.ms, 0)),
      rowsRead: all.reduce((s, q) => s + q.rowsRead, 0),
    },
  });
});

/**
 * "Live now" (lib/presence.ts): which of this shop's items shoppers in its city have open or are
 * hovering over, this second, plus the latest moments. Light enough to poll every 2 s: PostgreSQL
 * for the shelf (tens of rows), Valkey (or memory) for presence. No ClickHouse on this path.
 */
shopDashboard.get('/retailer/shop/live', async (req, res) => {
  const shop = await requireShop(req);
  const items = await shelf(shop);
  const byId = new Map(items.map((i) => [i.product_id, i]));
  const live = await livePresence(shop.city, items.map((i) => i.product_id));
  // Short, stable shopper labels for the feed ("Shopper 3f2a"): one-way, per shop, never an identity.
  const tag = (visitor: string) => createHash('sha256').update(`${shop.id}:${visitor}`).digest('hex').slice(0, 4);
  res.set('Cache-Control', 'no-store');
  res.json({
    at: Date.now(),
    source: live.source,
    shoppers: live.shoppers,
    products: [...live.products]
      .map(([productId, p]) => ({
        productId, name: byId.get(productId)?.name ?? `#${productId}`, qty: byId.get(productId)?.qty ?? 0,
        pricePaise: byId.get(productId)?.price_paise ?? 0, ...p,
      }))
      .sort((a, b) => b.viewing + b.hovering - (a.viewing + a.hovering) || b.lastAt - a.lastAt),
    feed: live.feed.map((f) => ({
      productId: f.productId, name: byId.get(f.productId)?.name ?? `#${f.productId}`, kind: f.kind, at: f.at, shopper: tag(f.visitor),
    })),
  });
});

/** One customer, as this shop sees them: their orders here, what of ours they look at, our coupons to them. */
shopDashboard.get('/retailer/shop/customers/:ref', async (req, res) => {
  const shop = await requireShop(req);
  const w = parse(Window, req.query);
  const email = await emailForRef(shop, parse(z.string().regex(/^[a-f0-9]{24}$/), req.params.ref));
  const items = await shelf(shop);
  const names = new Map(items.map((i) => [i.product_id, i.name]));
  const coupons = (await listCoupons(500, shop.id)).filter((c) => c.customerEmail === email)
    .map((c) => ({ ...c, customerEmail: showEmail(c.customerEmail) }));
  res.set('Cache-Control', 'no-store');
  if (!chEnabled()) {
    res.json({ email: showEmail(email), orders: [], looked: [], coupons });
    return;
  }
  await ensureSchema();
  const params = { days: w.days, demo: Number(w.demo), seller: shop.id, sellerName: shop.name, city: shop.city, products: JSON.stringify(items.map((i) => i.product_id)), email };
  const [orders, looked] = await Promise.all([
    chSelect<Record<string, string>>(
      `SELECT o.order_number AS order_number, o.at AS at, o.total_paise AS total, o.discount_paise AS discount,
              o.coupon AS coupon, o.source AS source, l.product_id AS product_id, l.qty AS qty
         FROM (${SHOP_ORDERS}) AS o
         INNER JOIN (SELECT order_id, product_id, qty FROM order_lines FINAL WHERE ${SELLER_MATCH}) AS l ON l.order_id = o.order_id
        WHERE o.customer_email = {email:String} ORDER BY o.at DESC LIMIT 30`,
      params,
    ),
    chSelect<Record<string, string>>(
      `SELECT product_id, count() AS views FROM (${SHOP_VIEWS})
        WHERE type = 'page_view' AND visitor IN (SELECT visitor FROM orders FINAL WHERE customer_email = {email:String} AND visitor != '')
        GROUP BY product_id ORDER BY views DESC LIMIT 8`,
      params,
    ),
  ]);
  res.json({
    email: showEmail(email),
    orders: orders.rows.map((o) => ({
      orderNumber: o.order_number, at: iso(o.at), totalPaise: n(o.total), discountPaise: n(o.discount), coupon: o.coupon,
      demo: o.source === 'demo', product: names.get(n(o.product_id)) ?? `#${o.product_id}`, qty: n(o.qty),
    })),
    looked: looked.rows.map((l) => ({ name: names.get(n(l.product_id)) ?? `#${l.product_id}`, views: n(l.views) })),
    coupons,
  });
});

/**
 * The shop gives one of its regulars a coupon. It works only for that customer (signed in with that
 * email, doc/17) and only when buying from this shop.
 */
shopDashboard.post('/retailer/shop/coupons', async (req, res) => {
  const shop = await requireShop(req);
  const b = parse(
    z.object({
      ref: z.string().regex(/^[a-f0-9]{24}$/, 'customer ref'),
      percentOff: z.number().int().min(1).max(90),
      days: z.number().int().min(1).max(90).default(7),
      reason: z.string().trim().max(120).optional(),
      productId: z.number().int().positive().optional(),
    }),
    req.body,
  );
  const email = await emailForRef(shop, b.ref);
  const had = await ordersAtShop(shop, email);
  if (had < COUPON_MIN_ORDERS) {
    throw new HttpError(400, 'VALIDATION', `Coupons are for your regulars: ${showEmail(email)} has ${had} order${had === 1 ? '' : 's'} with ${shop.name} (needs ${COUPON_MIN_ORDERS}).`);
  }
  if (b.productId) {
    const sells = await getPool().query('SELECT 1 FROM seller_offers WHERE seller_id = $1 AND product_id = $2', [shop.id, b.productId]);
    if (!sells.rowCount) throw new HttpError(400, 'VALIDATION', `${shop.name} doesn’t sell that product.`);
  }
  const coupon = await issueCoupon({
    email, percentOff: b.percentOff, days: b.days, reason: b.reason,
    productId: b.productId ?? null, city: shop.city, sellerId: shop.id,
  });
  res.status(201).json({ ...coupon, customerEmail: showEmail(coupon.customerEmail) });
});
