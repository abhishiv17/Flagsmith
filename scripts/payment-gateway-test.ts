import 'dotenv/config';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

/** Live Razorpay Test Mode checks. Creates gateway orders, never charges money. */
const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) throw new Error('ADMIN_TOKEN is required');
if (!process.env.test_api_key?.startsWith('rzp_test_') || !process.env.test_key_secret) {
  throw new Error('Razorpay Test Mode keys are required');
}

const server = createApp().listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Cannot determine local port');
const base = `http://127.0.0.1:${address.port}/api/payments/test`;
const checks: string[] = [];

async function post(body: unknown, auth = true) {
  const response = await fetch(`${base}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { 'x-admin-token': adminToken! } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

try {
  const unauthorized = await post({ amountPaise: 100 }, false);
  assert.equal(unauthorized.status, 401);
  checks.push('unauthenticated create rejected');

  for (const amountPaise of [undefined, 99, 100_001, 100.5, '100']) {
    const invalid = await post(amountPaise === undefined ? {} : { amountPaise });
    assert.equal(invalid.status, 400);
  }
  checks.push('missing, below-minimum, above-maximum, fractional and string amounts rejected');

  const malformed = await fetch(`${base}/orders/not-an-order`, { headers: { 'x-admin-token': adminToken } });
  assert.equal(malformed.status, 400);
  checks.push('malformed order ID rejected');

  const created = await post({ amountPaise: 100 });
  assert.equal(created.status, 201);
  assert.equal(created.body.testMode, true);
  assert.equal(created.body.amountPaise, 100);
  assert.equal(created.body.amountPaidPaise, 0);
  assert.equal(created.body.status, 'created');
  const orderId = String(created.body.gatewayOrderId);
  assert.match(orderId, /^order_[A-Za-z0-9]+$/);
  checks.push('₹1 test order created, unpaid');

  const fetchedResponse = await fetch(`${base}/orders/${orderId}`, { headers: { 'x-admin-token': adminToken } });
  assert.equal(fetchedResponse.status, 200);
  const fetched = await fetchedResponse.json() as Record<string, unknown>;
  assert.equal(fetched.gatewayOrderId, orderId);
  assert.equal(fetched.amountPaidPaise, 0);
  assert.equal(fetched.amountDuePaise, 100);
  checks.push('created order fetched with ₹1 due');

  const upper = await post({ amountPaise: 100_000 });
  assert.equal(upper.status, 201);
  assert.equal(upper.body.amountPaise, 100_000);
  checks.push('₹1,000 boundary order created, unpaid');

  const concurrent = await Promise.all(Array.from({ length: 5 }, () => post({ amountPaise: 100 })));
  assert.ok(concurrent.every((result) => result.status === 201));
  assert.equal(new Set(concurrent.map((result) => result.body.gatewayOrderId)).size, 5);
  assert.equal(new Set(concurrent.map((result) => result.body.receipt)).size, 5);
  assert.ok(concurrent.every((result) => result.body.amountPaidPaise === 0));
  checks.push('5 concurrent test orders created with unique IDs and receipts, all unpaid');

  console.log(JSON.stringify({ passed: checks.length, checks, exampleOrderId: orderId }, null, 2));
} finally {
  server.close();
}
