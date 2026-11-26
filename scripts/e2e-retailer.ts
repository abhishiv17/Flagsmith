/**
 * End-to-end check of the retailer features on a deployed site (doc/16): Customers dashboard on
 * ClickHouse, coupon links (product + city), coupon redemption at checkout, prices across cities.
 *
 * Places ONE real order (1 unit of the best-stocked product, with a 10 % coupon) for a fictional
 * e2e customer on example.com, then waits for it to reach ClickHouse through Kafka.
 *
 * Usage: npm run e2e:retailer -- --base=https://<app>   (needs ADMIN_TOKEN in .env)
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

const base = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? `http://localhost:${process.env.PORT ?? 4000}`;
const admin = process.env.ADMIN_TOKEN ?? '';
let failed = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${what}${detail ? `  ${detail}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Shopper {
  private cookie = '';
  async call(method: string, path: string, body?: unknown, asAdmin = false) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', cookie: this.cookie, ...(asAdmin ? { 'x-admin-token': admin } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    // Keep every cookie (guest session + sign-in), replacing by name.
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0]!;
      const k = kv.split('=')[0]!;
      this.cookie = this.cookie.split('; ').filter((x) => x && !x.startsWith(`${k}=`)).concat(kv).join('; ');
    }
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
  /** Passwordless sign-in with the on-screen demo code (doc/17); coupons need it. */
  async signIn(email: string, name: string) {
    const code = await this.call('POST', '/api/auth/code', { email });
    return this.call('POST', '/api/auth/verify', { email, code: code.data.demoCode, name });
  }
}

type Overview = { totals: { orders: number; couponOrders: number; discountPaise: number; events: number }; customers: any[]; clickhouse: { ms: number; queries: number } };

async function main() {
  console.log(`Retailer E2E against ${base}\n`);
  const s = new Shopper();
  const shop = new Shopper();

  // 1. Pages and redirects (SPA: the server returns the app, the router does the rest)
  for (const p of ['/', '/ops', '/ops/customers', '/retailer', '/customers', '/ops/customer']) {
    const r = await s.call('GET', p);
    check(r.status === 200, `page ${p} loads`, String(r.status));
  }
  const html = (await s.call('GET', '/')).data as string;
  const js = /\/assets\/index-[^"]+\.js/.exec(html)?.[0];
  const bundle = js ? ((await s.call('GET', js)).data as string) : '';
  check(['"/retailer"', '"/customers"', '"/ops/customer"'].every((r) => bundle.includes(r)), 'deployed bundle has /retailer, /customers, /ops/customer → /ops/customers', js ?? 'no bundle');

  // 2. Workers: the ClickHouse sink is alive and keeping up with Kafka
  const sum = (await s.call('GET', '/api/ops/summary')).data;
  const ch = sum.workers?.find((w: any) => w.name === 'clickhouse');
  check(Boolean(ch?.up), 'clickhouse worker heartbeat', ch ? (ch.up ? 'up' : 'down') : 'missing');
  const chLag = (sum.consumers ?? []).filter((c: any) => c.group === 'clickhouse');
  check(chLag.length === 2 && chLag.every((c: any) => c.lag <= 5), 'clickhouse consumer group lag (orders.placed, user.activity)', chLag.map((c: any) => `${c.topic}:${c.lag}`).join(' '));

  // 3. Dashboard API: admin-only, answers from ClickHouse
  check((await s.call('GET', '/api/retailer/customers')).status === 401, 'customers API refuses without the admin token');
  const all = await s.call('GET', '/api/retailer/customers?days=30&demo=1', undefined, true);
  const ov = all.data as Overview;
  check(all.status === 200 && ov.customers?.length > 0, 'customers API with token (demo history on)', `${ov.customers?.length} customers · ClickHouse ${ov.clickhouse?.queries} queries ${Math.round(ov.clickhouse?.ms)} ms`);
  const liveOnly = (await s.call('GET', '/api/retailer/customers?days=30&demo=0', undefined, true)).data as Overview;
  check(liveOnly.customers.every((c) => c.live), 'demo toggle off → only real customers', `${liveOnly.customers.length} real customers, ${liveOnly.totals.orders} real orders`);
  const top = ov.customers.find((c) => c.viewedId && c.topCity);
  check(Boolean(top), 'customers carry a link target (most-viewed product + home city)', top ? `${top.name}: #${top.viewedId} ${top.viewedName} in ${top.topCity}` : '');
  const spread = await s.call('GET', '/api/retailer/price-spread', undefined, true);
  check(spread.status === 200 && spread.data.items.length > 0, 'price-spread API', spread.data.items?.[0] ? `${spread.data.items[0].name} ₹${spread.data.items[0].minPaise / 100}–₹${spread.data.items[0].maxPaise / 100}` : '');

  // 4. Prices across cities (public)
  const prices = await s.call('GET', '/api/products/1/prices');
  check(prices.status === 200 && prices.data.cities.length === 3 && prices.data.cities.every((c: any) => c.partnerSellers > 0) && prices.data.minPaise < prices.data.maxPaise,
    'product 1 has partner prices in all 3 cities', `₹${prices.data.minPaise / 100} to ₹${prices.data.maxPaise / 100}`);

  // 5. Coupon link: product + city, public lookup without the email
  const city = 'BLR';
  const found = await s.call('GET', `/api/search?city=${city}&q=&size=48`);
  const product = [...found.data.items].sort((a: any, b: any) => b.qty - a.qty || a.pricePaise - b.pricePaise)[0];
  const email = `e2e.retailer.${Date.now()}@example.com`;
  const issued = await s.call('POST', '/api/retailer/coupons', { email, percentOff: 10, days: 1, reason: 'automated e2e check', productId: product.productId, city }, true);
  const c = issued.data;
  check(issued.status === 201 && c.link === `/p/${product.productId}?city=${city}&coupon=${c.code}`, 'issue coupon → link opens the product in the city', c.link);
  const pub = await s.call('GET', `/api/coupons/${c.code}`);
  check(pub.status === 200 && pub.data.productId === product.productId && pub.data.city === city && pub.data.status === 'open' && !JSON.stringify(pub.data).includes('@'),
    'public coupon lookup: offer, product and city, no email', `${pub.data.percentOff}% · ${pub.data.productName} · ${pub.data.city}`);
  check((await s.call('GET', c.link)).status === 200, 'coupon link page loads');
  check((await s.call('GET', '/api/coupons/NOPE-000000')).status === 404, 'unknown code → 404');

  // 6. Redeem at checkout (one real order, 1 unit)
  const add = await shop.call('POST', '/api/cart/items', { city, productId: product.productId, qty: 1 });
  check(add.status < 300, `add 1 × ${product.name} (${product.qty} in stock) in ${city}`);
  const guestTry = await new Shopper().call('POST', '/api/coupons/preview', { city, email, code: c.code });
  check(guestTry.status === 401, 'coupon without signing in → sign in first', `"${guestTry.data.error?.message}"`);
  check((await shop.signIn(email, 'E2E Retailer Check')).status === 200, 'shopper signs in with the coupon’s email (cart comes along)');
  const other = new Shopper();
  await other.signIn(`e2e.other.${Date.now()}@example.com`, 'E2E Someone Else');
  const wrong = await other.call('POST', '/api/coupons/preview', { city, email: 'someone.else@example.com', code: c.code });
  check(wrong.status === 409 && wrong.data.error.code === 'COUPON_INVALID', 'someone else signed in → refused', `"${wrong.data.error?.message}"`);
  const prev = await shop.call('POST', '/api/coupons/preview', { city, email, code: c.code.toLowerCase() });
  const expected = Math.floor((product.pricePaise * 10) / 100 / 100) * 100;
  check(prev.status === 200 && prev.data.discountPaise === expected, 'preview (lower-case code) → 10 % off, whole rupees', `−₹${prev.data.discountPaise / 100} on ₹${product.pricePaise / 100}`);
  const key = randomUUID();
  const order = await shop.call('POST', '/api/checkout', { city, customer: { name: 'E2E Retailer Check', email }, idempotencyKey: key, couponCode: c.code });
  check(order.status === 201 && order.data.discountPaise === expected && order.data.totalPaise === product.pricePaise - expected,
    'checkout with the coupon → discounted total', `${order.data.orderNumber} · ₹${order.data.totalPaise / 100} (${order.data.status})`);
  const replay = await shop.call('POST', '/api/checkout', { city, customer: { name: 'E2E Retailer Check', email }, idempotencyKey: key, couponCode: c.code });
  check(replay.status === 200 && replay.data.orderId === order.data.orderId, 'same idempotency key → same order');
  await shop.call('POST', '/api/cart/items', { city, productId: product.productId, qty: 1 });
  const reuse = await shop.call('POST', '/api/checkout', { city, customer: { name: 'E2E Retailer Check', email }, idempotencyKey: randomUUID(), couponCode: c.code });
  check(reuse.status === 409 && reuse.data.error.code === 'COUPON_INVALID', 'reusing the coupon → refused', `"${reuse.data.error?.message}"`);
  await shop.call('DELETE', `/api/cart/items/${product.productId}?city=${city}`); // leave no claim behind
  check((await s.call('GET', `/api/coupons/${c.code}`)).data.status === 'used', 'coupon now shows as used');

  // 7. The order reaches ClickHouse through outbox → Kafka → clickhouse worker
  let seen: any = null;
  for (let i = 0; i < 20 && !seen; i++) {
    await sleep(3000);
    const d = await s.call('GET', `/api/retailer/customers/${encodeURIComponent(email)}?days=1&demo=0`, undefined, true);
    seen = d.data.orders?.find((o: any) => o.orderNumber === order.data.orderNumber);
  }
  check(Boolean(seen) && seen.coupon === c.code && seen.discountPaise === expected, 'order is in ClickHouse with its coupon and discount', seen ? `${seen.orderNumber} ₹${seen.totalPaise / 100} −₹${seen.discountPaise / 100}` : 'not seen in 60 s');
  const after = (await s.call('GET', '/api/retailer/customers?days=30&demo=0', undefined, true)).data as Overview;
  check(after.totals.couponOrders > liveOnly.totals.couponOrders, 'dashboard counts the coupon order', `${liveOnly.totals.couponOrders} → ${after.totals.couponOrders}`);

  // 8. Clicks reach ClickHouse too
  const before = after.totals.events;
  await s.call('POST', '/api/track', { events: [{ type: 'page_view', at: Date.now(), path: `/p/${product.productId}`, city }] });
  let events = before;
  for (let i = 0; i < 15 && events <= before; i++) {
    await sleep(3000);
    events = ((await s.call('GET', '/api/retailer/customers?days=30&demo=0', undefined, true)).data as Overview).totals.events;
  }
  check(events > before, 'a tracked click reaches ClickHouse', `${before} → ${events} events`);

  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ all retailer checks passed');
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
