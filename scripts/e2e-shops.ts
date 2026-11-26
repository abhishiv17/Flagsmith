/**
 * End-to-end check of retailer accounts (doc/18) on a deployed site, with the demo logins:
 *   retailer sign-in → own dashboard · coupon only for a regular · coupon only for that customer at
 *   that shop · two shoppers race for a shop's last unit · the sale shows on the shop's dashboard.
 *
 * Uses Volt Bazaar (Mumbai), Rohan (its regular), Nisha and Arjun (fresh). Places up to 3 real orders
 * at Volt Bazaar, then puts those items back to 1 left. Needs `npm run demo:seed` to have run.
 * Usage: npm run e2e:shops -- --base=https://<app>
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

const base = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? `http://localhost:${process.env.PORT ?? 4000}`;
let failed = 0;
const check = (ok: boolean, what: string, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${what}${detail ? `  ${detail}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Browser {
  private cookie = '';
  async call(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0]!;
      const k = kv.split('=')[0]!;
      this.cookie = this.cookie.split('; ').filter((x) => x && !x.startsWith(`${k}=`)).concat(kv).join('; ');
    }
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, data };
  }
  async signIn(email: string) {
    const code = await this.call('POST', '/api/auth/code', { email });
    if (!code.data.demoCode) throw new Error(`no demo code for ${email}: ${JSON.stringify(code.data)}`);
    return (await this.call('POST', '/api/auth/verify', { email, code: code.data.demoCode })).data;
  }
}

async function main() {
  console.log(`Retailer accounts E2E against ${base}\n`);
  const shop = new Browser();
  const rohan = new Browser();
  const nisha = new Browser();
  const arjun = new Browser();

  // 1. Retailer signs in and sees only their shop.
  check((await shop.call('GET', '/api/retailer/shop')).status === 401, 'dashboard refuses a guest');
  const me = await shop.signIn('volt.bazaar@example.com');
  check(me.retailer?.name === 'Volt Bazaar' && me.retailer?.city === 'MUM', 'volt.bazaar@example.com signs in as the shop', `${me.retailer?.name} · ${me.retailer?.cityName}`);
  const d0 = await shop.call('GET', '/api/retailer/shop?days=60');
  const v0 = d0.data;
  check(d0.status === 200 && v0.shop.name === 'Volt Bazaar' && v0.customers.length > 10,
    'own dashboard (ClickHouse)', `${v0.totals?.orders} orders · ${v0.customers?.length} customers · ${v0.stock.lastUnits} items at 1 left · ${v0.clickhouse?.ms} ms`);
  const r = v0.customers.find((c: any) => c.email === 'rohan@example.com');
  check(Boolean(r) && r.orders >= 2 && r.canGetCoupon, 'Rohan is a Volt Bazaar regular', r ? `${r.orders} orders · ${r.segment}` : 'missing');
  check(v0.customers.every((c: any) => /@example\.(com|org)$/.test(c.email) || c.email.includes('***')), 'real customers are masked');

  // 2. Coupons only for regulars.
  const once = v0.customers.find((c: any) => c.orders === 1);
  const refused = await shop.call('POST', '/api/retailer/shop/coupons', { ref: once.ref, percentOff: 10 });
  check(refused.status === 400, 'no coupon for a one-order customer', `"${refused.data.error?.message}"`);
  const gives = await shop.call('POST', '/api/retailer/shop/coupons', { ref: r.ref, percentOff: 15, days: 1, reason: 'e2e', productId: r.viewedId ?? r.favouriteId });
  const coupon = gives.data;
  check(gives.status === 201 && coupon.sellerName === 'Volt Bazaar' && coupon.city === 'MUM', 'coupon for Rohan, opens his item in Mumbai', coupon.link);
  const pub = (await nisha.call('GET', `/api/coupons/${coupon.code}`)).data;
  check(pub.sellerName === 'Volt Bazaar' && !JSON.stringify(pub).includes('@'), 'public lookup names the shop, not the customer');

  // 3. Only Rohan, only at Volt Bazaar.
  const productId = coupon.productId as number;
  check((await rohan.call('POST', '/api/coupons/preview', { city: 'MUM', email: 'rohan@example.com', code: coupon.code, sellerId: 1e6, productId })).status >= 400,
    'refused before sign-in / at an unknown shop');
  await rohan.signIn('rohan@example.com');
  await nisha.signIn('nisha@example.com');
  await arjun.signIn('arjun@example.com');
  const wrongPerson = await nisha.call('POST', '/api/coupons/preview', { city: 'MUM', email: 'nisha@example.com', code: coupon.code, sellerId: me.retailer.id, productId });
  check(wrongPerson.status === 409, 'Nisha can’t use Rohan’s coupon', `"${wrongPerson.data.error?.message}"`);
  const tune = (await rohan.call('GET', `/api/offers?productId=${productId}&city=MUM`)).data.items.find((o: any) => o.sellerId !== me.retailer.id);
  if (tune) {
    const wrongShop = await rohan.call('POST', '/api/coupons/preview', { city: 'MUM', email: 'rohan@example.com', code: coupon.code, sellerId: tune.sellerId, productId });
    check(wrongShop.status === 409, `Rohan can’t use it at ${tune.sellerName}`, `"${wrongShop.data.error?.message}"`);
  }
  const ok = await rohan.call('POST', '/api/coupons/preview', { city: 'MUM', email: 'rohan@example.com', code: coupon.code, sellerId: me.retailer.id, productId });
  check(ok.status === 200 && ok.data.discountPaise > 0, 'Rohan at Volt Bazaar: applies', `−₹${ok.data.discountPaise / 100} on ₹${ok.data.subtotalPaise / 100}`);
  const buy = await rohan.call('POST', '/api/checkout/offer', {
    city: 'MUM', idempotencyKey: randomUUID(), customer: { name: 'Rohan Mehta', email: 'rohan@example.com' },
    sellerId: me.retailer.id, productId, qty: 1, couponCode: coupon.code,
  });
  check(buy.status === 201 && buy.data.discountPaise === ok.data.discountPaise, 'Rohan buys from Volt Bazaar with it', `${buy.data.orderNumber} · ₹${buy.data.totalPaise / 100} (${buy.data.status})`);
  const again = await rohan.call('POST', '/api/coupons/preview', { city: 'MUM', email: 'rohan@example.com', code: coupon.code, sellerId: me.retailer.id, productId });
  check(again.status === 409, 'second use refused', `"${again.data.error?.message}"`);

  // 4. The race: Nisha and Arjun pay for Volt Bazaar's last unit at the same moment.
  const shelf = v0.stock.items.filter((i: any) => i.qty === 1 && i.productId !== productId);
  const prize = shelf[Math.floor(shelf.length / 2)];
  const body = (name: string, email: string) => ({
    city: 'MUM', idempotencyKey: randomUUID(), customer: { name, email }, sellerId: me.retailer.id, productId: prize.productId, qty: 1,
  });
  const [a, b] = await Promise.all([
    nisha.call('POST', '/api/checkout/offer', body('Nisha Kapoor', 'nisha@example.com')),
    arjun.call('POST', '/api/checkout/offer', body('Arjun Das', 'arjun@example.com')),
  ]);
  const statuses = [a.status, b.status].sort();
  const loser = a.status === 409 ? a : b;
  check(statuses[0] === 201 && statuses[1] === 409, `race for Volt Bazaar's last ${prize.name}: one winner`, `[${a.status}, ${b.status}] loser: "${loser.data.error?.message}"`);

  // 5. The shop sees it: sales in ClickHouse within seconds, shelf at 0.
  let seen = 0;
  for (let i = 0; i < 20 && seen < 2; i++) {
    await sleep(3000);
    const v = (await shop.call('GET', '/api/retailer/shop?days=1')).data;
    seen = v.recent.filter((o: any) => [buy.data.orderNumber, (a.status === 201 ? a : b).data.orderNumber].includes(o.orderNumber)).length;
  }
  check(seen === 2, 'both sales on Volt Bazaar’s dashboard (Kafka → ClickHouse)', `${seen}/2`);
  const after = (await shop.call('GET', '/api/retailer/shop?days=60')).data;
  check(after.stock.items.find((i: any) => i.productId === prize.productId)?.qty === 0, 'shelf shows it sold out');
  check(after.coupons.some((c: any) => c.code === coupon.code && c.redeemedOrderId), 'coupon shows as used');

  console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ all retailer-account checks passed');
  console.log('Put the shelf back to 1 left: npm run demo:seed -- --shelf');
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
