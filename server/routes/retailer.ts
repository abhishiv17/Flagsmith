import { Router, type Request } from 'express';
import { z } from 'zod';
import { env } from '../config.js';
import { getPool } from '../lib/db.js';
import { HttpError, parse } from '../lib/http.js';
import { chEnabled, chSelect, ensureSchema } from '../lib/clickhouse.js';
import { issueCoupon, listCoupons } from '../domain/coupons.js';

/**
 * Retailer "Customers" dashboard (doc/16). Who buys most, who browses most, what converts, and a
 * one-click loyalty coupon for a chosen customer.
 *
 * Reads: Aiven for ClickHouse (orders, order_lines, activity, fed from Kafka by the clickhouse worker).
 * Writes: coupons in PostgreSQL (the source of truth checkout checks against).
 * Everything here names real customers, so it needs the retailer's admin token.
 */
export const retailer = Router();

function requireAdmin(req: Request) {
  if (!env.ADMIN_TOKEN || req.get('x-admin-token') !== env.ADMIN_TOKEN) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Store admin token required');
  }
}

async function requireClickhouse() {
  if (!chEnabled()) throw new HttpError(503, 'SEARCH_UNAVAILABLE', 'ClickHouse is not connected to this app yet.');
  await ensureSchema();
}

const Window = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  demo: z.enum(['0', '1']).default('1'), // include the seeded demo history
});

// Every query filters the same way: inside the window, and live-only unless demo history is on.
const WHERE = `at >= now() - INTERVAL {days:UInt16} DAY AND ({demo:UInt8} = 1 OR source = 'live')`;

const n = (v: unknown) => Number(v ?? 0);
const iso = (v: unknown) => {
  const s = String(v ?? '');
  return !s || s.startsWith('1970') ? null : `${s.replace(' ', 'T')}Z`;
};

type Segment = 'vip' | 'browser' | 'lapsed' | 'regular' | 'new';
const SUGGEST: Record<Segment, { label: string; percent: number; why: string }> = {
  vip: { label: 'Top customer', percent: 10, why: 'Thank-you for being a top customer' },
  browser: { label: 'Browses a lot, buys little', percent: 15, why: 'A nudge for someone who keeps coming back' },
  lapsed: { label: 'Hasn’t ordered lately', percent: 20, why: 'Win back a regular who went quiet' },
  regular: { label: 'Regular', percent: 5, why: 'Small thank-you' },
  new: { label: 'New customer', percent: 10, why: 'Welcome back for a second order' },
};

retailer.get('/retailer/customers', async (req, res) => {
  requireAdmin(req);
  await requireClickhouse();
  const w = parse(Window, req.query);
  const params = { days: w.days, demo: Number(w.demo) };

  const [totals, people, daily, products] = await Promise.all([
    chSelect<Record<string, string>>(
      `SELECT
         (SELECT count() FROM orders FINAL WHERE ${WHERE}) AS orders,
         (SELECT uniqExact(customer_email) FROM orders FINAL WHERE ${WHERE}) AS customers,
         (SELECT sum(total_paise) FROM orders FINAL WHERE ${WHERE}) AS revenue,
         (SELECT sum(discount_paise) FROM orders FINAL WHERE ${WHERE}) AS discounts,
         (SELECT countIf(coupon != '') FROM orders FINAL WHERE ${WHERE}) AS coupon_orders,
         (SELECT uniqExact(visitor) FROM activity FINAL WHERE ${WHERE}) AS visitors,
         (SELECT count() FROM activity FINAL WHERE ${WHERE}) AS events,
         (SELECT countIf(type = 'page_view' AND product_id > 0) FROM activity FINAL WHERE ${WHERE}) AS product_views,
         (SELECT countIf(type = 'click' AND label = 'add-to-cart') FROM activity FINAL WHERE ${WHERE}) AS cart_adds`,
      params,
    ),
    // One row per customer (email): what they bought, plus everything their browser sessions did.
    // Sessions are linked to a customer only through their own orders (orders.visitor).
    chSelect<Record<string, unknown>>(
      `WITH
         o AS (
           SELECT customer_email, argMax(customer_name, at) AS name, count() AS orders, sum(total_paise) AS spend,
                  sum(items) AS units, max(at) AS last_order, min(at) AS first_order,
                  groupUniqArray(city) AS cities, topK(1)(city)[1] AS top_city, countIf(coupon != '') AS coupons_used,
                  countIf(source = 'live') AS live_orders
             FROM orders FINAL WHERE ${WHERE} GROUP BY customer_email),
         m AS (SELECT DISTINCT customer_email, visitor FROM orders FINAL WHERE ${WHERE} AND visitor != ''),
         a AS (
           SELECT visitor, count() AS events, countIf(type = 'page_view' AND product_id > 0) AS views,
                  countIf(type = 'click' AND label = 'add-to-cart') AS cart_adds, countIf(type = 'search') AS searches,
                  max(at) AS last_seen
             FROM activity FINAL WHERE ${WHERE} AND visitor != '' GROUP BY visitor),
         f AS (
           SELECT customer_email, topKWeighted(1)(name, toUInt64(qty))[1] AS favourite,
                  topKWeighted(1)(product_id, toUInt64(qty))[1] AS favourite_id
             FROM order_lines FINAL WHERE ${WHERE} GROUP BY customer_email),
         v AS (
           SELECT m2.customer_email AS customer_email, topK(1)(pv.product_id)[1] AS viewed_id
             FROM (SELECT DISTINCT customer_email, visitor FROM orders FINAL WHERE ${WHERE} AND visitor != '') AS m2
             INNER JOIN (SELECT visitor, product_id FROM activity FINAL
                          WHERE ${WHERE} AND type = 'page_view' AND product_id > 0) AS pv ON pv.visitor = m2.visitor
            GROUP BY m2.customer_email)
       SELECT o.customer_email AS email, o.name AS name, o.orders AS orders, o.spend AS spend, o.units AS units,
              o.last_order AS last_order, o.first_order AS first_order, o.cities AS cities, o.top_city AS top_city,
              o.coupons_used AS coupons_used, o.live_orders AS live_orders, any(f.favourite) AS favourite,
              any(f.favourite_id) AS favourite_id, any(v.viewed_id) AS viewed_id,
              sum(a.events) AS events, sum(a.views) AS views, sum(a.cart_adds) AS cart_adds,
              sum(a.searches) AS searches, max(a.last_seen) AS last_seen
         FROM o
         LEFT JOIN m ON m.customer_email = o.customer_email
         LEFT JOIN a ON a.visitor = m.visitor
         LEFT JOIN f ON f.customer_email = o.customer_email
         LEFT JOIN v ON v.customer_email = o.customer_email
        GROUP BY email, name, orders, spend, units, last_order, first_order, cities, top_city, coupons_used, live_orders
        ORDER BY spend DESC
        LIMIT 200`,
      params,
    ),
    chSelect<Record<string, string>>(
      `SELECT d, sum(orders) AS orders, sum(revenue) AS revenue, sum(visitors) AS visitors FROM (
         SELECT toDate(at) AS d, count() AS orders, sum(total_paise) AS revenue, 0 AS visitors FROM orders FINAL WHERE ${WHERE} GROUP BY d
         UNION ALL
         SELECT toDate(at) AS d, 0, 0, uniqExact(visitor) FROM activity FINAL WHERE ${WHERE} GROUP BY d)
       GROUP BY d ORDER BY d`,
      params,
    ),
    chSelect<Record<string, string>>(
      `SELECT product_id, sum(views) AS views, sum(viewers) AS viewers, sum(cart_adds) AS cart_adds,
              sum(units) AS units, sum(revenue) AS revenue, sum(buyers) AS buyers FROM (
         SELECT product_id, countIf(type = 'page_view') AS views, uniqExactIf(visitor, type = 'page_view') AS viewers,
                countIf(type = 'click' AND label = 'add-to-cart') AS cart_adds, 0 AS units, 0 AS revenue, 0 AS buyers
           FROM activity FINAL WHERE ${WHERE} AND product_id > 0 GROUP BY product_id
         UNION ALL
         SELECT product_id, 0, 0, 0, sum(qty), sum(qty * unit_price_paise), uniqExact(customer_email)
           FROM order_lines FINAL WHERE ${WHERE} GROUP BY product_id)
       GROUP BY product_id ORDER BY revenue DESC, views DESC LIMIT 15`,
      params,
    ),
  ]);

  // Segments: simple, explainable rules a shop owner can check by eye.
  const rows = people.rows.map((r) => ({
    email: String(r.email), name: String(r.name), orders: n(r.orders), spendPaise: n(r.spend), units: n(r.units),
    lastOrder: iso(r.last_order), firstOrder: iso(r.first_order), cities: (r.cities as string[]) ?? [],
    couponsUsed: n(r.coupons_used), live: n(r.live_orders) > 0, favourite: String(r.favourite ?? ''),
    events: n(r.events), views: n(r.views), cartAdds: n(r.cart_adds), searches: n(r.searches), lastSeen: iso(r.last_seen),
    topCity: String(r.top_city ?? '') || null, favouriteId: n(r.favourite_id) || null, viewedId: n(r.viewed_id) || null,
  }));
  const spends = rows.map((r) => r.spendPaise).sort((a, b) => b - a);
  const vipLine = spends[Math.max(0, Math.ceil(spends.length * 0.1) - 1)] ?? Infinity;
  const DAY = 86_400_000;
  const customers = rows.map((r) => {
    const quietDays = r.lastOrder ? (Date.now() - Date.parse(r.lastOrder)) / DAY : 0;
    const segment: Segment =
      r.spendPaise >= vipLine && r.orders >= 2 ? 'vip'
      : r.orders >= 2 && quietDays > 14 ? 'lapsed'
      : r.views >= 12 && r.orders <= 2 ? 'browser'
      : r.orders === 1 ? 'new'
      : 'regular';
    return { ...r, segment, suggestion: SUGGEST[segment] };
  });
  // Most engaged = what they did on the site, weighted toward intent (cart adds) over looking.
  const engaged = [...customers].sort((a, b) => b.views + 3 * b.cartAdds + b.searches - (a.views + 3 * a.cartAdds + a.searches)).slice(0, 10);

  const names = new Map(
    (await getPool().query<{ id: number; name: string }>('SELECT id, name FROM products')).rows.map((p) => [p.id, p.name]),
  );
  const t = totals.rows[0] ?? {};
  res.set('Cache-Control', 'no-store');
  res.json({
    windowDays: w.days,
    includesDemo: w.demo === '1',
    totals: {
      orders: n(t.orders), customers: n(t.customers), revenuePaise: n(t.revenue), discountPaise: n(t.discounts),
      couponOrders: n(t.coupon_orders), visitors: n(t.visitors), events: n(t.events),
      productViews: n(t.product_views), cartAdds: n(t.cart_adds),
    },
    customers: customers.map((c) => ({
      ...c,
      viewedName: c.viewedId ? names.get(c.viewedId) ?? null : null,
      favouriteName: c.favouriteId ? names.get(c.favouriteId) ?? null : null,
    })),
    engaged: engaged.map((c) => c.email),
    daily: daily.rows.map((d) => ({ day: d.d, orders: n(d.orders), revenuePaise: n(d.revenue), visitors: n(d.visitors) })),
    products: products.rows.map((p) => ({
      productId: n(p.product_id), name: names.get(n(p.product_id)) ?? `#${p.product_id}`, views: n(p.views),
      viewers: n(p.viewers), cartAdds: n(p.cart_adds), units: n(p.units), revenuePaise: n(p.revenue), buyers: n(p.buyers),
    })),
    clickhouse: {
      queries: 4,
      ms: Math.round(totals.ms + people.ms + daily.ms + products.ms),
      rowsRead: totals.rowsRead + people.rowsRead + daily.rowsRead + products.rowsRead,
    },
  });
});

/** One customer: what they bought and when, and what they looked at. */
retailer.get('/retailer/customers/:email', async (req, res) => {
  requireAdmin(req);
  await requireClickhouse();
  const w = parse(Window, req.query);
  const email = parse(z.email().max(120), req.params.email).toLowerCase();
  const params = { days: w.days, demo: Number(w.demo), email };
  const [orders, bought, looked] = await Promise.all([
    chSelect<Record<string, string>>(
      `SELECT order_number, at, city, total_paise, discount_paise, coupon, items, source
         FROM orders FINAL WHERE ${WHERE} AND customer_email = {email:String} ORDER BY at DESC LIMIT 20`,
      params,
    ),
    chSelect<Record<string, string>>(
      `SELECT any(name) AS name, sum(qty) AS units, sum(qty * unit_price_paise) AS spend
         FROM order_lines FINAL WHERE ${WHERE} AND customer_email = {email:String}
        GROUP BY product_id ORDER BY units DESC LIMIT 8`,
      params,
    ),
    chSelect<Record<string, string>>(
      `SELECT product_id, count() AS views FROM activity FINAL
        WHERE ${WHERE} AND type = 'page_view' AND product_id > 0
          AND visitor IN (SELECT visitor FROM orders FINAL WHERE customer_email = {email:String} AND visitor != '')
        GROUP BY product_id ORDER BY views DESC LIMIT 8`,
      params,
    ),
  ]);
  const names = new Map(
    (await getPool().query<{ id: number; name: string }>('SELECT id, name FROM products')).rows.map((p) => [p.id, p.name]),
  );
  const coupons = (await listCoupons(500)).filter((c) => c.customerEmail === email);
  res.set('Cache-Control', 'no-store');
  res.json({
    email,
    orders: orders.rows.map((o) => ({
      orderNumber: o.order_number, at: iso(o.at), city: o.city, totalPaise: n(o.total_paise),
      discountPaise: n(o.discount_paise), coupon: o.coupon, items: n(o.items), demo: o.source === 'demo',
    })),
    bought: bought.rows.map((b) => ({ name: b.name, units: n(b.units), spendPaise: n(b.spend) })),
    looked: looked.rows.map((l) => ({ name: names.get(n(l.product_id)) ?? `#${l.product_id}`, views: n(l.views) })),
    coupons,
  });
});

retailer.get('/retailer/coupons', async (req, res) => {
  requireAdmin(req);
  res.set('Cache-Control', 'no-store');
  res.json({ items: await listCoupons(100), maxPercent: env.COUPON_PERCENT_MAX });
});

retailer.post('/retailer/coupons', async (req, res) => {
  requireAdmin(req);
  const b = parse(
    z.object({
      email: z.email().max(120),
      percentOff: z.number().int().min(1).max(90),
      days: z.number().int().min(1).max(90).default(7),
      maxDiscountRupees: z.number().int().positive().max(100_000).optional(),
      reason: z.string().trim().max(120).optional(),
      productId: z.number().int().positive().optional(),
      city: z.enum(['BLR', 'MUM', 'DEL']).optional(),
    }),
    req.body,
  );
  const coupon = await issueCoupon({
    email: b.email, percentOff: b.percentOff, days: b.days,
    maxDiscountPaise: b.maxDiscountRupees ? b.maxDiscountRupees * 100 : null, reason: b.reason,
    productId: b.productId ?? null, city: b.city ?? null,
  });
  res.status(201).json(coupon);
});

/**
 * Same product, every city: our own price and stock, plus the partner shops' cheapest and dearest
 * offer there. Public (it's what a shopper could see anyway); also feeds the retailer's price table.
 */
retailer.get('/products/:id/prices', async (req, res) => {
  const id = parse(z.coerce.number().int().positive(), req.params.id);
  const { rows } = await getPool().query<{
    code: string; city: string; own_price: number; own_qty: number | null;
    min_price: number | null; max_price: number | null; sellers: number; partner_qty: number | null;
  }>(
    `SELECT c.code, c.name AS city, p.price_paise AS own_price, i.qty AS own_qty,
            min(o.price_paise) FILTER (WHERE o.qty > 0) AS min_price,
            max(o.price_paise) FILTER (WHERE o.qty > 0) AS max_price,
            count(o.*) FILTER (WHERE o.qty > 0)::int AS sellers,
            sum(o.qty)::int AS partner_qty
       FROM products p
       CROSS JOIN cities c
       LEFT JOIN inventory i ON i.product_id = p.id AND i.city_code = c.code
       LEFT JOIN sellers s ON s.city_code = c.code
       LEFT JOIN seller_offers o ON o.seller_id = s.id AND o.product_id = p.id
      WHERE p.id = $1
      GROUP BY c.code, c.name, p.price_paise, i.qty
      ORDER BY c.code`,
    [id],
  );
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such product.');
  const prices = rows.flatMap((r) => [r.own_price, r.min_price, r.max_price]).filter((v): v is number => v != null);
  res.set('Cache-Control', 'no-store');
  res.json({
    productId: id,
    minPaise: Math.min(...prices),
    maxPaise: Math.max(...prices),
    cities: rows.map((r) => ({
      code: r.code, city: r.city, ownPricePaise: r.own_price, ownQty: r.own_qty ?? 0,
      partnerMinPaise: r.min_price, partnerMaxPaise: r.max_price, partnerSellers: r.sellers, partnerQty: r.partner_qty ?? 0,
    })),
  });
});

/** Retailer view: which products have the widest price gap between cities (partner shops vs ours). */
retailer.get('/retailer/price-spread', async (req, res) => {
  requireAdmin(req);
  const { rows } = await getPool().query<{
    id: number; name: string; own: number; lo: number; hi: number; cheapest_city: string; dearest_city: string;
    by_city: { code: string; lo: number; hi: number }[];
  }>(
    `WITH per_city AS (
       SELECT o.product_id, s.city_code AS code, min(o.price_paise) AS lo, max(o.price_paise) AS hi
         FROM seller_offers o JOIN sellers s ON s.id = o.seller_id
        WHERE o.qty > 0 GROUP BY o.product_id, s.city_code)
     SELECT p.id, p.name, p.price_paise AS own, min(pc.lo) AS lo, max(pc.hi) AS hi,
            (array_agg(pc.code ORDER BY pc.lo))[1] AS cheapest_city,
            (array_agg(pc.code ORDER BY pc.hi DESC))[1] AS dearest_city,
            jsonb_agg(jsonb_build_object('code', pc.code, 'lo', pc.lo, 'hi', pc.hi) ORDER BY pc.code) AS by_city
       FROM products p JOIN per_city pc ON pc.product_id = p.id
      GROUP BY p.id, p.name, p.price_paise
      ORDER BY (max(pc.hi) - min(pc.lo))::float / p.price_paise DESC
      LIMIT 25`,
  );
  res.set('Cache-Control', 'no-store');
  res.json({
    items: rows.map((r) => ({
      productId: r.id, name: r.name, ownPricePaise: r.own, minPaise: r.lo, maxPaise: r.hi,
      cheapestCity: r.cheapest_city, dearestCity: r.dearest_city, byCity: r.by_city,
    })),
  });
});
