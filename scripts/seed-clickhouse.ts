/**
 * Demo history for the retailer's Customers dashboard (doc/16): 30 days of FICTIONAL shoppers
 * (orders + clicks) written straight into ClickHouse with source = 'demo'.
 *
 * Why: the live shop only has a handful of test customers, so "who buys most" would be a list of us.
 * Nothing here touches PostgreSQL: stock, real orders and coupons are unchanged. The dashboard can
 * hide demo rows (toggle), and every demo email is on example.com.
 *
 * Deterministic (fixed random seed) and idempotent: tables are ReplacingMergeTree keyed by order id /
 * event id, so re-running replaces the same rows instead of adding more.
 *
 * Usage: npm run clickhouse:seed            (needs CLICKHOUSE_URL and DATABASE_URL in .env)
 *        npm run clickhouse:seed -- --reset (delete demo rows first)
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { closePool, getPool } from '../server/lib/db.js';
import { chExec, chInsert, chQuery, ensureSchema } from '../server/lib/clickhouse.js';

const DAYS = 30;
const CITIES = ['BLR', 'MUM', 'DEL'] as const;

// mulberry32: small seeded PRNG, so every run produces the same people and the same history.
let seed = 20261121;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const hex = (s: string, len: number) => createHash('sha256').update(s).digest('hex').slice(0, len);
const uuid = (s: string) => {
  const h = hex(s, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const ts = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

type Persona = 'vip' | 'regular' | 'browser' | 'lapsed' | 'new';
const PLAN: { persona: Persona; count: number; orders: [number, number]; views: [number, number]; recentOnly?: boolean; oldOnly?: boolean }[] = [
  { persona: 'vip', count: 6, orders: [6, 11], views: [45, 90] },
  { persona: 'regular', count: 14, orders: [2, 4], views: [10, 30] },
  { persona: 'browser', count: 8, orders: [1, 1], views: [28, 60] },
  { persona: 'lapsed', count: 6, orders: [3, 5], views: [4, 10], oldOnly: true },
  { persona: 'new', count: 6, orders: [1, 1], views: [3, 9], recentOnly: true },
];

const FIRST = ['Priya', 'Arjun', 'Kavya', 'Rohan', 'Ananya', 'Vikram', 'Meera', 'Aditya', 'Sneha', 'Karthik', 'Isha', 'Rahul',
  'Divya', 'Siddharth', 'Pooja', 'Nikhil', 'Aisha', 'Varun', 'Neha', 'Harsh', 'Lakshmi', 'Imran', 'Tanvi', 'Manoj', 'Riya',
  'Farhan', 'Shreya', 'Gautam', 'Nandini', 'Abhay', 'Zoya', 'Pranav', 'Sanjana', 'Kabir', 'Deepa', 'Yash', 'Anjali', 'Tarun',
  'Fatima', 'Suresh'];
const LAST = ['Nair', 'Sharma', 'Reddy', 'Iyer', 'Gupta', 'Menon', 'Khan', 'Rao', 'Patel', 'Das', 'Kulkarni', 'Singh', 'Joshi',
  'Bose', 'Pillai', 'Mehta', 'Shetty', 'Verma', 'Hegde', 'Chatterjee'];
const SEARCHES = ['earbuds', 'charger', 'power bank', 'headphones', 'smart watch', 'speaker', 'cable', 'backpack', 'kettle',
  'phone case', 'mouse', 'keyboard', 'lamp', 'bottle', 'trimmer'];

async function main() {
  const reset = process.argv.includes('--reset');
  await ensureSchema();
  if (reset) {
    for (const t of ['orders', 'order_lines', 'activity']) {
      await chExec(`ALTER TABLE ${t} DELETE WHERE source = 'demo' SETTINGS mutations_sync = 1`);
    }
    console.log('deleted previous demo rows');
  }

  const { rows: products } = await getPool().query<{ id: number; name: string; category: string; price_paise: number }>(
    'SELECT id, name, category, price_paise FROM products ORDER BY id',
  );
  const categories = [...new Set(products.map((p) => p.category))];
  const now = Date.now();
  const DAY = 86_400_000;

  const orders: Record<string, unknown>[] = [];
  const lines: Record<string, unknown>[] = [];
  const activity: Record<string, unknown>[] = [];
  let eventId = 1_000_000_000_000; // far above live outbox ids; demo rows also sort under source='demo'
  let orderNo = 0;

  const view = (visitor: string, city: string, at: number, page: string, productId = 0, extra: Partial<Record<string, unknown>> = {}) =>
    activity.push({ event_id: eventId++, at: ts(at), type: 'page_view', visitor, city, page, label: '', product_id: productId, q: '', source: 'demo', ...extra });

  let personIx = 0;
  for (const group of PLAN) {
    for (let k = 0; k < group.count; k++, personIx++) {
      const first = FIRST[personIx % FIRST.length]!;
      const last = LAST[(personIx * 7) % LAST.length]!;
      const name = `${first} ${last}`;
      const email = `${first}.${last}`.toLowerCase() + '@example.com';
      const home = CITIES[personIx % 3]!;
      const likes = [pick(categories), pick(categories)];
      const liked = products.filter((p) => likes.includes(p.category));
      const visitors = Array.from({ length: int(1, group.persona === 'vip' ? 3 : 2) }, (_, d) => hex(`demo:${email}:${d}`, 16));
      const dayOf = () => (group.recentOnly ? int(0, 5) : group.oldOnly ? int(17, DAYS - 1) : int(0, DAYS - 1));

      // Browsing: product pages (mostly in their favourite categories), searches, cart adds, home.
      const views = int(...group.views);
      for (let v = 0; v < views; v++) {
        const at = now - dayOf() * DAY - int(0, 20 * 3600) * 1000;
        const visitor = pick(visitors);
        const p = rnd() < 0.75 && liked.length ? pick(liked) : pick(products);
        if (rnd() < 0.2) view(visitor, home, at - 60_000, '/');
        if (rnd() < 0.25) {
          activity.push({ event_id: eventId++, at: ts(at - 30_000), type: 'search', visitor, city: home, page: '/shop', label: '',
            product_id: 0, q: pick(SEARCHES), source: 'demo' });
        }
        view(visitor, home, at, '/p/:id', p.id);
        const cartRate = group.persona === 'browser' ? 0.3 : group.persona === 'vip' ? 0.35 : 0.15;
        if (rnd() < cartRate) {
          activity.push({ event_id: eventId++, at: ts(at + 20_000), type: 'click', visitor, city: home, page: '/p/:id',
            label: 'add-to-cart', product_id: p.id, q: '', source: 'demo' });
        }
      }

      // Orders: each one preceded by its product views and cart adds, so funnels add up.
      const nOrders = int(...group.orders);
      for (let o = 0; o < nOrders; o++) {
        const at = now - dayOf() * DAY - int(0, 20 * 3600) * 1000;
        const city = rnd() < 0.85 ? home : pick(CITIES);
        const visitor = pick(visitors);
        const items = Array.from({ length: group.persona === 'vip' ? int(1, 4) : int(1, 2) }, () =>
          rnd() < 0.8 && liked.length ? pick(liked) : pick(products));
        const uniq = [...new Map(items.map((p) => [p.id, p])).values()];
        const id = uuid(`demo-order:${email}:${o}`);
        let total = 0;
        let units = 0;
        for (const p of uniq) {
          const qty = rnd() < 0.15 ? 2 : 1;
          total += qty * p.price_paise;
          units += qty;
          view(visitor, city, at - 240_000, '/p/:id', p.id);
          activity.push({ event_id: eventId++, at: ts(at - 200_000), type: 'click', visitor, city, page: '/p/:id',
            label: 'add-to-cart', product_id: p.id, q: '', source: 'demo' });
          lines.push({ order_id: id, product_id: p.id, at: ts(at), city, customer_email: email, name: p.name, qty,
            unit_price_paise: p.price_paise, seller: '', source: 'demo' });
        }
        view(visitor, city, at - 60_000, '/checkout');
        view(visitor, city, at, '/orders/:id');
        orderNo++;
        orders.push({ order_id: id, at: ts(at), order_number: `SH-${city}-D${String(orderNo).padStart(4, '0')}`, city,
          customer_email: email, customer_name: name, visitor, total_paise: total, discount_paise: 0, coupon: '',
          items: units, source: 'demo' });
      }
    }
  }

  // Anonymous visitors who never ordered: they make "visitors" bigger than "customers", like a real shop.
  for (let a = 0; a < 70; a++) {
    const visitor = hex(`demo:anon:${a}`, 16);
    const city = pick(CITIES);
    for (let v = int(1, 8); v > 0; v--) {
      const at = now - int(0, DAYS - 1) * DAY - int(0, 20 * 3600) * 1000;
      const p = pick(products);
      view(visitor, city, at, '/p/:id', p.id);
      if (rnd() < 0.1) {
        activity.push({ event_id: eventId++, at: ts(at + 15_000), type: 'click', visitor, city, page: '/p/:id',
          label: 'add-to-cart', product_id: p.id, q: '', source: 'demo' });
      }
    }
  }

  const chunk = async (table: string, rows: Record<string, unknown>[]) => {
    for (let i = 0; i < rows.length; i += 5000) await chInsert(table, rows.slice(i, i + 5000));
  };
  const t0 = Date.now();
  await chunk('orders', orders);
  await chunk('order_lines', lines);
  await chunk('activity', activity);
  console.log(`demo history: ${orders.length} orders, ${lines.length} order lines, ${activity.length} activity events (${Date.now() - t0} ms)`);

  const top = await chQuery<Record<string, string>>(
    `SELECT customer_email, count() AS orders, round(sum(total_paise) / 100) AS rupees
       FROM orders FINAL WHERE source = 'demo' GROUP BY customer_email ORDER BY rupees DESC LIMIT 5`,
  );
  console.table(top);
}

main()
  .catch((e) => {
    console.error('clickhouse:seed failed:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
