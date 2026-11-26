/**
 * Demo accounts for the pitch (doc/18): 4 retailer logins, 9 shoppers with order history at those
 * retailers, 3 fresh shoppers for the live race, and a crowd of fictional customers so each retailer's
 * dashboard has something to show. Everything is fictional (example.com / example.org).
 *
 *   PostgreSQL  4 shops get an owner email; every item on their shelf is set to 1 left (the race demo);
 *               the 12 shopper accounts are created verified; the 9 with history get real orders
 *               (backdated, status confirmed) so /account lists them. No outbox events: history only.
 *               Each shop's top 2 customers are named accounts with an open coupon from that shop.
 *   ClickHouse  those orders, plus ~2 months of crowd orders and product views at the 4 shops,
 *               source = 'demo'.
 *
 * Deterministic and idempotent: fixed ids, re-running replaces rows and resets the shelves to 1.
 * Usage: npm run demo:seed            (needs DATABASE_URL and ClickHouse in .env)
 *        npm run demo:seed -- --shelf (only reset the 4 shops' shelves to 1 left)
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { closePool, getPool, withTx } from '../server/lib/db.js';
import { chEnabled, chExec, chInsert, ensureSchema } from '../server/lib/clickhouse.js';
import { visitorId } from '../server/domain/activity.js';

const DAY = 86_400_000;
const NOW = Date.now();

let seed = 20261122;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const uuid = (s: string) => {
  const h = createHash('sha256').update(`demo18:${s}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const ts = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
/** A time `daysAgo` back, during shop hours (10:00–21:00 IST). */
const at = (daysAgo: number) => {
  const d = new Date(NOW - daysAgo * DAY);
  d.setUTCHours(4 + int(0, 11), int(0, 59), int(0, 59), 0);
  return Math.min(d.getTime(), NOW - 60_000);
};

export const RETAILERS = [
  { slug: 'gadget-gully-blr', email: 'gadget.gully@example.com' },
  { slug: 'echo-ohm-blr', email: 'echo.ohm@example.com' },
  { slug: 'volt-bazaar-mum', email: 'volt.bazaar@example.com' },
  { slug: 'circuit-corner-del', email: 'circuit.corner@example.com' },
] as const;

type Slug = (typeof RETAILERS)[number]['slug'];
/**
 * A shop's top customer: one of its two biggest spenders (the seed makes sure nobody in the crowd
 * outspends them), with an open coupon from that shop that works only for them, only at that shop.
 */
type Top = { code: string; percent: number; why: string };
type Plan = { shop: Slug; orders: number; within: [number, number]; top?: Top };
/** Shoppers with history: who they are, where they shop, what they like. */
export const SHOPPERS: { name: string; email: string; city: string; plan: Plan[]; likes: string[]; extraViews?: Slug }[] = [
  // Gadget Gully (Bengaluru): top 2
  { name: 'Asha Rao', email: 'asha@example.com', city: 'BLR', likes: ['audio', 'wearables'],
    plan: [{ shop: 'gadget-gully-blr', orders: 11, within: [1, 50], top: { code: 'GULLY10-ASHA', percent: 10, why: 'Thank-you for being one of our best customers' } },
      { shop: 'echo-ohm-blr', orders: 1, within: [10, 30] }] },
  { name: 'Vikram Shetty', email: 'vikram@example.com', city: 'BLR', likes: ['mobile-accessories', 'home-kitchen'],
    plan: [{ shop: 'gadget-gully-blr', orders: 9, within: [2, 44], top: { code: 'GULLY15-VIKRAM', percent: 15, why: 'A thank-you from Gadget Gully' } }] },
  // Echo & Ohm (Bengaluru): top 2
  { name: 'Meera Iyer', email: 'meera@example.com', city: 'BLR', likes: ['wearables', 'home-kitchen'],
    plan: [{ shop: 'echo-ohm-blr', orders: 9, within: [2, 45], top: { code: 'ECHO10-MEERA', percent: 10, why: 'Thank-you for being one of our best customers' } }] },
  { name: 'Leela Menon', email: 'leela@example.com', city: 'BLR', likes: ['audio', 'bags-travel'],
    plan: [{ shop: 'echo-ohm-blr', orders: 8, within: [1, 40], top: { code: 'ECHO15-LEELA', percent: 15, why: 'A thank-you from Echo & Ohm' } }] },
  // Volt Bazaar (Mumbai): top 2
  { name: 'Rohan Mehta', email: 'rohan@example.com', city: 'MUM', likes: ['mobile-accessories', 'audio'],
    plan: [{ shop: 'volt-bazaar-mum', orders: 10, within: [1, 40], top: { code: 'VOLT10-ROHAN', percent: 10, why: 'Thank-you for being one of our best customers' } }] },
  { name: 'Farhan Ali', email: 'farhan@example.com', city: 'MUM', likes: ['wearables', 'home-kitchen'],
    plan: [{ shop: 'volt-bazaar-mum', orders: 8, within: [3, 45], top: { code: 'VOLT15-FARHAN', percent: 15, why: 'A thank-you from Volt Bazaar' } }] },
  // Circuit Corner (Delhi): top 2
  { name: 'Kabir Singh', email: 'kabir@example.com', city: 'DEL', likes: ['home-kitchen', 'bags-travel'],
    plan: [{ shop: 'circuit-corner-del', orders: 10, within: [16, 50], top: { code: 'CIRCUIT20-KABIR', percent: 20, why: 'We miss you: come back to us' } }] }, // gone quiet: nothing in 16 days
  { name: 'Tanya Bose', email: 'tanya@example.com', city: 'DEL', likes: ['audio', 'wearables'],
    plan: [{ shop: 'circuit-corner-del', orders: 9, within: [1, 40], top: { code: 'CIRCUIT10-TANYA', percent: 10, why: 'Thank-you for being one of our best customers' } }] },
  { name: 'Dev Patel', email: 'dev@example.com', city: 'BLR', likes: ['bags-travel', 'audio'], extraViews: 'echo-ohm-blr',
    plan: [{ shop: 'gadget-gully-blr', orders: 1, within: [3, 12] }, { shop: 'volt-bazaar-mum', orders: 1, within: [15, 25] }] },
];
/** Fresh accounts for the live demo (two laptops racing for one last unit). No history. */
export const FRESH = [
  { name: 'Nisha Kapoor', email: 'nisha@example.com' },
  { name: 'Arjun Das', email: 'arjun@example.com' },
  { name: 'Zoya Khan', email: 'zoya@example.com' },
];

const FIRST = ['Aarav', 'Bhavna', 'Chetan', 'Diya', 'Esha', 'Farah', 'Gaurav', 'Hema', 'Ishaan', 'Jaya', 'Kiran', 'Leela', 'Mohan',
  'Naveen', 'Ojas', 'Pallavi', 'Qadir', 'Ritu', 'Sameer', 'Tara', 'Uday', 'Vani', 'Wasim', 'Yamini', 'Zubin', 'Anil', 'Bina', 'Chirag'];
const LAST = ['Agarwal', 'Bhat', 'Chopra', 'Desai', 'Ghosh', 'Jain', 'Kamath', 'Lal', 'Malhotra', 'Naidu', 'Oberoi', 'Prasad', 'Saxena', 'Thakur'];

type Offer = { product_id: number; name: string; category: string; price_paise: number };

async function main() {
  const pool = getPool();
  const shelfOnly = process.argv.includes('--shelf');

  // 1. Retailer owners + every item on their shelf at 1 left.
  const shops = new Map<Slug, { id: number; name: string; city: string; offers: Offer[] }>();
  for (const r of RETAILERS) {
    const s = await pool.query<{ id: number; name: string; city_code: string }>(
      'UPDATE sellers SET owner_email = $2 WHERE slug = $1 RETURNING id, name, city_code', [r.slug, r.email],
    );
    if (!s.rows[0]) throw new Error(`Shop ${r.slug} missing: run npm run sellers:seed and prices:seed first`);
    await pool.query('UPDATE seller_offers SET qty = 1, updated_at = now() WHERE seller_id = $1', [s.rows[0].id]);
    const offers = await pool.query<Offer>(
      `SELECT o.product_id, p.name, p.category, o.price_paise FROM seller_offers o JOIN products p ON p.id = o.product_id
        WHERE o.seller_id = $1 ORDER BY o.product_id`,
      [s.rows[0].id],
    );
    shops.set(r.slug, { id: s.rows[0].id, name: s.rows[0].name, city: s.rows[0].city_code, offers: offers.rows });
  }
  console.log('shops:', [...shops.values()].map((s) => `${s.name} (${s.city}, ${s.offers.length} items at 1 left)`).join(' · '));
  if (shelfOnly) return;

  // 2. Shopper accounts (verified, so the passwordless sign-in finds them).
  const ids = new Map<string, string>();
  for (const p of [...SHOPPERS, ...FRESH]) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO customers (name, email, email_verified_at) VALUES ($1, $2, now())
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, email_verified_at = COALESCE(customers.email_verified_at, now())
       RETURNING id`,
      [p.name, p.email],
    );
    ids.set(p.email, rows[0]!.id);
  }

  const chOrders: Record<string, unknown>[] = [];
  const chLines: Record<string, unknown>[] = [];
  const chActivity: Record<string, unknown>[] = [];
  let eventId = 3_000_000_000_000;
  const view = (visitor: string, city: string, productId: number, when: number, label = '') => {
    chActivity.push({ event_id: eventId++, at: ts(when), type: 'page_view', visitor, city, page: '/p/:id', label, product_id: productId, q: '', source: 'demo' });
  };
  const choose = (offers: Offer[], likes: string[]) => {
    const liked = offers.filter((o) => likes.includes(o.category));
    return rnd() < 0.8 && liked.length ? pick(liked) : pick(offers);
  };
  /** Top customers lean to the dearer half of the shelf. */
  const chooseDear = (offers: Offer[], likes: string[]) => {
    const median = [...offers].sort((a, b) => a.price_paise - b.price_paise)[Math.floor(offers.length / 2)]!.price_paise;
    const dear = offers.filter((o) => o.price_paise >= median);
    const liked = dear.filter((o) => likes.includes(o.category));
    return rnd() < 0.8 && liked.length ? pick(liked) : pick(dear);
  };

  const tops: { shop: string; name: string; email: string; code: string; percent: number; item: string }[] = [];
  // 3. The named shoppers' orders: real PostgreSQL orders (so /account shows them) + the same in ClickHouse.
  let named = 0;
  await withTx(async (tx) => {
    for (const p of SHOPPERS) {
      const customerId = ids.get(p.email)!;
      const visitor = visitorId(`acct:${customerId}`);
      for (const step of p.plan) {
        const shop = shops.get(step.shop)!;
        for (let k = 0; k < step.orders; k++) {
          const daysAgo = step.within[0] + ((step.within[1] - step.within[0]) * (step.orders - k)) / step.orders + rnd();
          let when = at(daysAgo);
          const item = { ...(step.top ? chooseDear : choose)(shop.offers, p.likes) };
          const key = `demo-seed:${p.email}:${step.shop}:${k}`;
          const id = uuid(key);
          // The first time this shopper used a coupon: Asha's 4th order at Gadget Gully used the shop's 10 % thank-you.
          const couponCode = p.email === 'asha@example.com' && step.shop === 'gadget-gully-blr' && k === 3 ? 'THANKS10-GGASHA' : null;
          const discount = couponCode ? Math.floor(item.price_paise * 0.1 / 100) * 100 : 0;
          if (couponCode) {
            await tx.query(
              `INSERT INTO coupons (code, customer_email, percent_off, reason, expires_at, created_at, product_id, city_code, seller_id)
               VALUES ($1, $2, 10, 'Thank-you for being one of our best customers', $3, $4, $5, $6, $7)
               ON CONFLICT (code) DO NOTHING`,
              [couponCode, p.email, new Date(when + 7 * DAY), new Date(when - 2 * DAY), item.product_id, shop.city, shop.id],
            );
          }
          const ins = await tx.query<{ order_no: string }>(
            `INSERT INTO orders (id, customer_id, city_code, status, total_paise, idempotency_key, created_at, session_id, discount_paise, coupon_code)
             VALUES ($1, $2, $3, 'confirmed', $4, $5, $6, $7, $8, $9)
             ON CONFLICT (idempotency_key) DO NOTHING RETURNING order_no`,
            [id, customerId, shop.city, item.price_paise - discount, key, new Date(when), `acct:${customerId}`, discount, couponCode],
          );
          let orderNo = ins.rows[0]?.order_no;
          if (orderNo) {
            await tx.query(
              'INSERT INTO order_items (order_id, product_id, qty, unit_price_paise, seller_id) VALUES ($1, $2, 1, $3, $4)',
              [id, item.product_id, item.price_paise, shop.id],
            );
            if (couponCode) await tx.query('UPDATE coupons SET redeemed_order_id = $1, redeemed_at = $2 WHERE code = $3', [id, new Date(when), couponCode]);
            named++;
          } else {
            // Already seeded: keep what PostgreSQL has, so both stores agree.
            const old = await tx.query<{ order_no: string; product_id: number; unit_price_paise: number; created_at: Date }>(
              'SELECT o.order_no, o.created_at, i.product_id, i.unit_price_paise FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.id = $1', [id],
            );
            orderNo = old.rows[0]!.order_no;
            when = old.rows[0]!.created_at.getTime();
            Object.assign(item, { product_id: old.rows[0]!.product_id, price_paise: old.rows[0]!.unit_price_paise });
            item.name = shop.offers.find((o) => o.product_id === item.product_id)?.name ?? item.name;
          }
          chOrders.push({
            order_id: id, at: ts(when), order_number: `SH-${shop.city}-${orderNo}`, city: shop.city, customer_email: p.email,
            customer_name: p.name, visitor, total_paise: item.price_paise - discount, discount_paise: discount,
            coupon: couponCode ?? '', items: 1, source: 'demo',
          });
          chLines.push({
            order_id: id, product_id: item.product_id, at: ts(when), city: shop.city, customer_email: p.email, name: item.name,
            qty: 1, unit_price_paise: item.price_paise, seller: shop.name, seller_id: shop.id, source: 'demo',
          });
          // Looked before buying: a few views of the item and its neighbours in the shop's city.
          for (let v = 0; v < int(2, 5); v++) view(visitor, shop.city, v === 0 ? item.product_id : choose(shop.offers, p.likes).product_id, when - int(5, 600) * 60_000);
        }
      }
      // A top customer's open coupon from their shop: only for them, only at that shop, on the item they buy most there.
      for (const step of p.plan.filter((s) => s.top)) {
        const shop = shops.get(step.shop)!;
        const counts = new Map<number, number>();
        for (const l of chLines) {
          if (l.customer_email === p.email && l.seller_id === shop.id) counts.set(l.product_id as number, (counts.get(l.product_id as number) ?? 0) + 1);
        }
        const fav = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
        await tx.query(
          `INSERT INTO coupons (code, customer_email, percent_off, reason, expires_at, product_id, city_code, seller_id)
           VALUES ($1, $2, $3, $4, now() + interval '30 days', $5, $6, $7)
           ON CONFLICT (code) DO UPDATE SET expires_at = EXCLUDED.expires_at, product_id = EXCLUDED.product_id
             WHERE coupons.redeemed_order_id IS NULL`,
          [step.top!.code, p.email, step.top!.percent, step.top!.why, fav, shop.city, shop.id],
        );
        tops.push({ shop: shop.name, name: p.name, email: p.email, code: step.top!.code, percent: step.top!.percent, item: shop.offers.find((o) => o.product_id === fav)?.name ?? String(fav) });
      }
      // Window-shopping between orders, mostly at their favourite shop's shelf.
      const fav = shops.get(p.extraViews ?? p.plan[0]!.shop)!;
      for (let v = 0; v < (p.extraViews ? 26 : int(10, 18)); v++) view(visitor, fav.city, choose(fav.offers, p.likes).product_id, at(rnd() * 30));
    }
  });

  // 4. The crowd: 45 customers per shop, a few loyal regulars, most buying once or twice.
  let crowd = 0;
  for (const [slug, shop] of shops) {
    const n = 45;
    for (let c = 0; c < n; c++) {
      const first = pick(FIRST);
      const last = pick(LAST);
      const email = `${first}.${last}.${slug.split('-')[0]}${c}@example.org`.toLowerCase();
      const name = `${first} ${last}`;
      const visitor = visitorId(`demo18-crowd:${slug}:${c}`);
      const orders = c < 5 ? int(7, 12) : c < 16 ? int(3, 5) : c < 30 ? int(1, 2) : c < 40 ? 1 : 0; // a few loyal regulars; the last few only look
      const likes = [pick(['audio', 'wearables', 'mobile-accessories', 'home-kitchen', 'bags-travel'])];
      for (let k = 0; k < orders; k++) {
        const when = at(c >= 30 && c < 34 ? int(25, 58) : rnd() < 0.75 ? rnd() * 30 + 0.1 : rnd() * 58 + 0.2);
        const item = choose(shop.offers, likes);
        const qty = rnd() < 0.12 ? 2 : 1;
        const id = uuid(`crowd:${slug}:${c}:${k}`);
        crowd++;
        chOrders.push({
          order_id: id, at: ts(when), order_number: `SH-${shop.city}-S${String(crowd).padStart(4, '0')}`, city: shop.city,
          customer_email: email, customer_name: name, visitor, total_paise: item.price_paise * qty, discount_paise: 0, coupon: '',
          items: qty, source: 'demo',
        });
        chLines.push({
          order_id: id, product_id: item.product_id, at: ts(when), city: shop.city, customer_email: email, name: item.name,
          qty, unit_price_paise: item.price_paise, seller: shop.name, seller_id: shop.id, source: 'demo',
        });
        for (let v = 0; v < int(1, 4); v++) view(visitor, shop.city, v === 0 ? item.product_id : choose(shop.offers, likes).product_id, when - int(5, 900) * 60_000);
      }
      // A known shopper who only looks needs an order somewhere to be known: one old order at another shop.
      if (orders === 0) {
        const other = [...shops.values()].find((s) => s.id !== shop.id && s.city === shop.city) ?? [...shops.values()].find((s) => s.id !== shop.id)!;
        const item = pick(other.offers);
        const id = uuid(`crowd-other:${slug}:${c}`);
        const when = at(int(30, 58));
        chOrders.push({
          order_id: id, at: ts(when), order_number: `SH-${other.city}-S${String(++crowd).padStart(4, '0')}`, city: other.city,
          customer_email: email, customer_name: name, visitor, total_paise: item.price_paise, discount_paise: 0, coupon: '', items: 1, source: 'demo',
        });
        chLines.push({
          order_id: id, product_id: item.product_id, at: ts(when), city: other.city, customer_email: email, name: item.name,
          qty: 1, unit_price_paise: item.price_paise, seller: other.name, seller_id: other.id, source: 'demo',
        });
        for (let v = 0; v < int(6, 14); v++) view(visitor, shop.city, choose(shop.offers, likes).product_id, at(rnd() * 20));
      } else {
        for (let v = 0; v < int(2, 8); v++) view(visitor, shop.city, choose(shop.offers, likes).product_id, at(rnd() * 30));
      }
    }
    // Anonymous browsers in the shop's city.
    for (let a = 0; a < 45; a++) {
      const visitor = visitorId(`demo18-anon:${slug}:${a}`);
      for (let v = 0; v < int(1, 5); v++) view(visitor, shop.city, pick(shop.offers).product_id, at(rnd() * 30));
    }
  }

  // 4b. Each shop's two top customers stay on top: trim crowd orders (dearest first) from anyone
  //     who would come close to the lesser of them, in the default 30-day view and over two months.
  const msOf = (r: Record<string, unknown>) => Date.parse(`${String(r.at).replace(' ', 'T')}Z`);
  const priceOf = (l: Record<string, unknown>) => (l.qty as number) * (l.unit_price_paise as number);
  const spend = (ls: Record<string, unknown>[], days: number) => ls.filter((l) => msOf(l) >= NOW - days * DAY).reduce((s, l) => s + priceOf(l), 0);
  const drop = new Set<string>();
  for (const shop of shops.values()) {
    const topEmails = tops.filter((t) => t.shop === shop.name).map((t) => t.email);
    const lines = chLines.filter((l) => l.seller_id === shop.id);
    const of = (e: string) => lines.filter((l) => l.customer_email === e);
    const floor30 = Math.min(...topEmails.map((e) => spend(of(e), 30))) * 0.9;
    const floorAll = Math.min(...topEmails.map((e) => spend(of(e), 3650))) * 0.9;
    for (const e of new Set(lines.map((l) => String(l.customer_email)).filter((x) => !topEmails.includes(x)))) {
      const mine = of(e).sort((a, b) => priceOf(b) - priceOf(a));
      while (mine.length > 1) {
        const over30 = spend(mine, 30) > floor30;
        if (!over30 && spend(mine, 3650) <= floorAll) break;
        const i = over30 ? mine.findIndex((l) => msOf(l) >= NOW - 30 * DAY) : 0;
        if (!String(mine[i]!.customer_email).endsWith('@example.org')) break; // named shoppers' orders are real: keep
        drop.add(String(mine[i]!.order_id));
        mine.splice(i, 1);
      }
    }
  }
  const keep = (r: Record<string, unknown>) => !drop.has(String(r.order_id));
  chOrders.splice(0, chOrders.length, ...chOrders.filter(keep));
  chLines.splice(0, chLines.length, ...chLines.filter(keep));
  console.log(`top customers kept on top: ${drop.size} crowd orders trimmed`);

  // 5. ClickHouse.
  if (!chEnabled()) {
    console.log('ClickHouse not configured: PostgreSQL part done only.');
  } else {
    await ensureSchema();
    // Live partner orders from before seller_id existed: fill it in from the shop name.
    const all = await pool.query<{ id: number; name: string }>('SELECT id, name FROM sellers');
    await chExec(
      `ALTER TABLE order_lines UPDATE seller_id = transform(seller, [${all.rows.map((s) => `'${s.name.replace(/'/g, "\\'")}'`).join(',')}],
         [${all.rows.map((s) => s.id).join(',')}], toUInt32(0)) WHERE seller != '' AND seller_id = 0`,
    );
    // Replace this seed's earlier rows (the crowd's size may have changed since the last run).
    await chExec(`DELETE FROM orders WHERE source = 'demo' AND customer_email LIKE '%@example.org'`);
    await chExec(`DELETE FROM order_lines WHERE source = 'demo' AND customer_email LIKE '%@example.org'`);
    await chExec(`DELETE FROM activity WHERE source = 'demo' AND event_id >= 3000000000000`);
    for (let i = 0; i < chActivity.length; i += 5000) await chInsert('activity', chActivity.slice(i, i + 5000));
    await chInsert('orders', chOrders);
    await chInsert('order_lines', chLines);
  }
  console.log(`accounts: ${SHOPPERS.length} with history (${named} new orders in PostgreSQL), ${FRESH.length} fresh · retailers: ${RETAILERS.length}`);
  console.log('top customers (coupon only for them, only at that shop):');
  for (const t of tops) console.log(`  ${t.shop.padEnd(15)} ${t.name.padEnd(14)} ${t.email.padEnd(22)} ${t.code.padEnd(16)} ${t.percent}% off ${t.item}`);
  console.log(`ClickHouse: ${chOrders.length} orders, ${chLines.length} lines, ${chActivity.length} product views (source = demo)`);
}

main()
  .catch((e) => {
    console.error('demo:seed failed:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
