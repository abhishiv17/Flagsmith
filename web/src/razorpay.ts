/**
 * Razorpay Standard Checkout (Test Mode). Loads Razorpay's script on demand and opens the payment
 * window for a pending StockHop order. Only the public test key reaches the browser; the server
 * verifies every payment (signature + Razorpay's own record) before an order is confirmed.
 */

export interface PaymentHandle {
  keyId: string;
  gatewayOrderId: string;
  amountPaise: number;
  reservedUntil: string;
}

export interface PaymentSuccess {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', cb: (r: { error?: { description?: string; code?: string } }) => void): void;
}
type RazorpayCtor = new (options: Record<string, unknown>) => RazorpayInstance;

let loading: Promise<RazorpayCtor> | null = null;

function loadScript(): Promise<RazorpayCtor> {
  const existing = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
  if (existing) return Promise.resolve(existing);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.async = true;
    s.onload = () => {
      const ctor = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
      if (ctor) resolve(ctor);
      else reject(new Error('Razorpay did not load.'));
    };
    s.onerror = () => {
      loading = null;
      reject(new Error('Could not reach Razorpay. Check your connection and try again.'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Open Checkout. Resolves with the payment proof on success, or `null` when the shopper closes the
 * window without paying (failed attempts inside the window can be retried there; we only learn the
 * final outcome when it closes or succeeds).
 */
export async function payWithRazorpay(
  handle: PaymentHandle,
  details: { orderNumber: string; name: string; email: string; phone?: string },
): Promise<{ ok: true; proof: PaymentSuccess } | { ok: false; lastError?: string }> {
  const Razorpay = await loadScript();
  return new Promise((resolve) => {
    let lastError: string | undefined;
    let settled = false;
    const done = (r: { ok: true; proof: PaymentSuccess } | { ok: false; lastError?: string }) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const rzp = new Razorpay({
      key: handle.keyId,
      order_id: handle.gatewayOrderId,
      amount: handle.amountPaise,
      currency: 'INR',
      name: 'StockHop',
      description: `Order ${details.orderNumber} (test mode, no real money)`,
      prefill: { name: details.name, email: details.email, ...(details.phone ? { contact: details.phone } : {}) },
      theme: { color: '#b8223a' },
      handler: (proof: PaymentSuccess) => done({ ok: true, proof }),
      modal: { ondismiss: () => done({ ok: false, lastError }), confirm_close: false },
    });
    rzp.on('payment.failed', (r) => {
      lastError = r.error?.description || r.error?.code || 'The payment did not go through.';
    });
    rzp.open();
  });
}
