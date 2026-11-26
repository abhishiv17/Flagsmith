import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config.js';
import { HttpError } from './http.js';

type RazorpayOrder = {
  id: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  status: string;
  receipt: string;
  attempts: number;
};

function credentials() {
  const key = env.test_api_key?.trim();
  const secret = env.test_key_secret?.trim();
  if (!key || !secret || !key.startsWith('rzp_test_')) {
    throw new HttpError(500, 'INTERNAL', 'Razorpay Test Mode credentials are not configured.');
  }
  return { key, secret };
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const { key, secret } = credentials();
  let response: Response;
  try {
    response = await fetch(`https://api.razorpay.com/v1/${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(503, 'INTERNAL', 'Razorpay Test Mode is unreachable.');
  }
  if (!response.ok) {
    // Gateway responses can include sensitive account details; never echo them or credentials.
    throw new HttpError(502, 'INTERNAL', `Razorpay Test Mode rejected the request (HTTP ${response.status}).`);
  }
  return (await response.json()) as T;
}

export function createTestOrder(amountPaise: number, receipt: string) {
  return request<RazorpayOrder>('orders', {
    method: 'POST',
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt }),
  });
}

export function getTestOrder(orderId: string) {
  return request<RazorpayOrder>(`orders/${encodeURIComponent(orderId)}`, { method: 'GET' });
}

type RazorpayPayment = { id: string; order_id: string; status: string; amount: number; method: string; created_at: number };

export function getTestOrderPayments(orderId: string) {
  return request<{ count: number; items: RazorpayPayment[] }>(
    `orders/${encodeURIComponent(orderId)}/payments`, { method: 'GET' },
  );
}

export function publicTestKey() {
  return credentials().key;
}

/** True when Test Mode keys are configured: checkout then takes payment before confirming. */
export function paymentsEnabled(): boolean {
  if (env.CHECKOUT_PAYMENTS === 'off') return false; // test switch (config.ts)
  const key = env.test_api_key?.trim();
  return Boolean(key && key.startsWith('rzp_test_') && env.test_key_secret?.trim());
}

/**
 * Razorpay Standard Checkout signature: HMAC-SHA256(order_id + "|" + payment_id, key_secret).
 * Constant-time compare. A valid signature proves the browser callback came from Razorpay.
 */
export function signatureValid(gatewayOrderId: string, paymentId: string, signature: string): boolean {
  const expected = createHmac('sha256', credentials().secret).update(`${gatewayOrderId}|${paymentId}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

type RazorpayPaymentDetail = { id: string; order_id: string; status: string; amount: number; currency: string };

/** Ask Razorpay directly for the payment's state (belt and braces on top of the signature). */
export function getTestPayment(paymentId: string) {
  return request<RazorpayPaymentDetail>(`payments/${encodeURIComponent(paymentId)}`, { method: 'GET' });
}
