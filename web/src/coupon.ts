/**
 * A coupon link (/p/:id?city=…&coupon=CODE) is usually opened on one page and spent a few pages later
 * at checkout. Remember the code in this browser until an order uses it (doc/16).
 */
const KEY = 'stockhop.coupon';

export function rememberCoupon(code: string): void {
  try { localStorage.setItem(KEY, code.trim().toUpperCase()); } catch { /* storage blocked: the URL still works */ }
}

export function savedCoupon(): string {
  try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
}

export function forgetCoupon(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export interface PublicCoupon {
  code: string; percentOff: number; maxDiscountPaise: number | null; expiresAt: string;
  productId: number | null; productName: string | null; city: string | null; status: 'open' | 'used' | 'expired';
  /** A partner shop's coupon (doc/18): only works when buying from that shop. */
  sellerId?: number | null; sellerName?: string | null;
  /** null = sign in first; false = signed in as a different customer. */
  eligible: boolean | null;
}
