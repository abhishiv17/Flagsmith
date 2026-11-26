/**
 * End-to-end check of the whole flow against a running API (CP2 proof). Two shoppers, one unit.
 * Requires: API running (npm run dev:api or deployed URL) and workers running.
 * Usage: npm run e2e [-- --base=http://localhost:4000]
 * Leaves Everyday Buds BLR restocked to 1 at the end (via the admin endpoint → outbox).
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';

const base = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? `http://localhost:${process.env.PORT ?? 4000}`;
const admin = process.env.ADMIN_TOKEN ?? '';

class Shopper {
  private cookie = '';
  constructor(public name: string) {}
  async call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', cookie: this.cookie, 'x-admin-token': admin },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    return { status: res.status, data: (await res.json()) as T };
  }
}

let failures = 0;
function check(ok: boolean, label: string, extra = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`E2E against ${base}\n`);
  const a = new Shopper('A');
  const b = new Shopper('B');

  // Reset the hero product so the run is repeatable.
  const reset = await a.call('POST', '/api/admin/restock', { sku: 'AUD-001', city: 'BLR', qty: 1 });
  check(reset.status === 200, 'admin restock Everyday Buds BLR → 1', `v${reset.data.version}`);
  await sleep(2500); // let relay → Kafka → indexer apply it

  // 1. Search: the exact request from slide 2
  const s = await a.call('GET', '/api/search?q=' + encodeURIComponent('bluetoth earphones') + '&city=BLR&maxPrice=150000');
  const names = (s.data.items ?? []).map((i: any) => i.name);
  check(s.status === 200 && names.includes('Everyday Buds'), '"bluetoth earphones" · BLR · ≤₹1,500 finds Everyday Buds', `${s.data.tookMs} ms · ${names.join(', ')}`);
  const buds = s.data.items.find((i: any) => i.name === 'Everyday Buds');
  check(buds?.qty === 1, 'search shows "1 left" (index in sync)', `qty=${buds?.qty}`);

  // 2. Product page from PG
  const p = await a.call('GET', `/api/products/${buds.productId}`);
  check(p.status === 200 && p.data.stock.length === 3, 'product detail shows stock in 3 cities', p.data.stock.map((x: any) => `${x.city}:${x.qty}`).join(' '));

  // 3. Both shoppers add the last unit AT THE SAME TIME. Adding claims the unit (server/domain/cart.ts),
  //    so exactly one gets it and the other is told straight away, before they reach checkout.
  const add = { city: 'BLR', productId: buds.productId, qty: 1 };
  const [addA, addB] = await Promise.all([a.call('POST', '/api/cart/items', add), b.call('POST', '/api/cart/items', add)]);
  const adds = [addA, addB];
  const claimed = adds.filter((r) => r.status < 300);
  const refused = adds.filter((r) => r.status === 409);
  check(claimed.length === 1 && refused.length === 1, '2 shoppers add the last unit at once → 1 claim, 1 clean 409', `[${addA.status}, ${addB.status}]`);
  if (refused[0]) console.log(`   loser is told: "${refused[0].data.error.message}" (${refused[0].data.error.details?.reason})`);
  check(refused[0]?.data.error.details?.reason === 'in_someone_cart', 'loser hears "someone has it in their cart", not a generic error');
  const winner = addA.status < 300 ? a : b;
  const loser = winner === a ? b : a;
  const cartW = await winner.call('GET', '/api/cart?city=BLR');
  check(cartW.data.items.length === 1, 'cart persists server-side', `subtotal ₹${cartW.data.subtotalPaise / 100}`);

  // 4. The winner double-clicks Place Order: two identical submits at once → one order
  const customer = (n: string) => ({ name: `Shopper ${n}`, email: `shopper.${n.toLowerCase()}@example.com` });
  const key = randomUUID();
  const body = { city: 'BLR', customer: customer(winner.name), idempotencyKey: key };
  const [r1, r2] = await Promise.all([winner.call('POST', '/api/checkout', body), winner.call('POST', '/api/checkout', body)]);
  check([r1.status, r2.status].includes(201) && r1.data.orderId === r2.data.orderId, 'double-click Place Order → one order', `[${r1.status}, ${r2.status}]`);
  const win = r1.status === 201 ? r1 : r2;

  // 5. Idempotency: a later retry of the same request returns the same order
  const replay = await winner.call('POST', '/api/checkout', body);
  check(replay.status === 200 && replay.data.orderId === win.data.orderId, 'retry returns the same order (idempotency key)');

  // 5b. After the sale, the loser trying again is told it's sold out here
  const again = await loser.call('POST', '/api/cart/items', add);
  check(again.status === 409 && again.data.error.details?.reason === 'sold_out', 'loser retries → "sold out here"', `"${again.data.error?.message}"`);

  // 6. Notifier consumer sends the confirmation (Kafka → consumer → PG)
  let conf = false;
  for (let i = 0; i < 20 && !conf; i++) {
    await sleep(1000);
    conf = (await winner.call('GET', `/api/orders/${win.data.orderId}`)).data.confirmationSent;
  }
  check(conf, `order ${win.data.orderNumber}: notifier consumer sent confirmation`);

  // 7. Search index reflects the sale (Kafka → indexer → OpenSearch)
  let live: any;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    live = (await a.call('GET', `/api/stock?city=BLR&ids=${buds.productId}`)).data.items[0];
    if (live?.qty === 0) break;
  }
  check(live?.qty === 0 && live?.inStock === false, 'live stock in index flipped to out of stock',
    live?.nearby ? `nearby: ${live.nearby.qty} left in ${live.nearby.cityName}` : '');

  // 8. Ops view
  const o = await a.call('GET', '/api/ops/summary');
  check(o.data.index?.inSync === o.data.index?.docs, '/ops: index in sync with PostgreSQL', `${o.data.index?.inSync}/${o.data.index?.docs}`);
  check(o.data.outbox?.pending === 0, '/ops: outbox drained', `pending=${o.data.outbox?.pending}`);
  console.log(`   workers: ${o.data.workers.map((w: any) => `${w.name}:${w.up ? 'up' : 'DOWN'}`).join(' ')}`);

  // Restore demo state
  await a.call('POST', '/api/admin/restock', { sku: 'AUD-001', city: 'BLR', qty: 1 });
  console.log(`\n${failures ? `❌ ${failures} check(s) failed` : '✅ all checks passed'}`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error('e2e crashed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
