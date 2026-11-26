import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, cityName, del, inr, post, uuid, type Offer, type ProductDetail, type ShortItem } from '../api';
import { useAccount, useCart, useCity } from '../state';
import { payWithRazorpay, type PaymentHandle } from '../razorpay';
import { PartnerOffers } from '../components/PartnerOffers';
import { scrollToTop } from '../motion';
import { forgetCoupon, rememberCoupon, savedCoupon } from '../coupon';

type Phase = 'idle' | 'reserving' | 'paying' | 'confirming';

interface CheckoutResponse {
  orderId: string;
  orderNumber: string;
  totalPaise: number;
  discountPaise?: number;
  status: 'confirmed' | 'pending_payment' | 'cancelled';
  sellerName?: string;
  payment?: PaymentHandle;
}

/** Buying one item from a partner retailer instead of our own shelf. */
interface PartnerPick {
  sellerId: number;
  sellerName: string;
  productId: number;
  productName: string;
  pricePaise: number;
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: '',
  reserving: 'Reserving your items…',
  paying: 'Waiting for payment…',
  confirming: 'Confirming your payment…',
};

/**
 * Checkout (doc/06 §2, doc/13). Pay-then-confirm, for our own cart or a partner retailer:
 *   1. reserve: POST /checkout (cart) or /checkout/offer (one partner item), row-locked, returns a
 *      Razorpay order;
 *   2. Razorpay Checkout opens; on success the server verifies the payment and confirms the order;
 *   3. closed or failed: the hold is released at once (cart restored / partner stock returned).
 * If our last unit goes to someone else, the shopper sees the same item from partner retailers in
 * their city and can buy it here, without leaving StockHop.
 */
export function Checkout() {
  const { city } = useCity();
  const { cart, refresh } = useCart();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const key = useRef(uuid());
  const formRef = useRef<HTMLFormElement>(null);
  const { account } = useAccount();
  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  // Signed in (doc/17): fill in the account's details; the email is the verified one and can't change.
  useEffect(() => {
    if (account) setForm((f) => ({ name: f.name || account.name, email: account.email, phone: f.phone || account.phone || '' }));
  }, [account]);
  const [couponNeedsSignIn, setCouponNeedsSignIn] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const submitting = phase !== 'idle';
  const [error, setError] = useState<{ message: string; items?: ShortItem[] } | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [partner, setPartner] = useState<PartnerPick | null>(null);
  const [busySeller, setBusySeller] = useState<number | null>(null);
  const [offersRound, setOffersRound] = useState(0);
  // Loyalty coupon from the store (doc/16): checked for this email, re-checked by checkout under a lock.
  // From a coupon link (?coupon=) or remembered from an earlier page of the same visit.
  const [couponInput, setCouponInput] = useState(() => (params.get('coupon') ?? savedCoupon()).toUpperCase());
  const [coupon, setCoupon] = useState<{ code: string; percentOff: number; discountPaise: number } | null>(null);
  const [couponMsg, setCouponMsg] = useState<string | null>(null);
  const [checkingCoupon, setCheckingCoupon] = useState(false);
  // A coupon's discount depends on the cart and the email: drop it if either changes.
  useEffect(() => { setCoupon(null); }, [cart?.subtotalPaise, form.email, partner?.sellerId, partner?.productId]);

  const applyCoupon = async () => {
    const code = couponInput.trim();
    if (!code) return;
    // Coupons belong to one email. The server decides whether that needs sign-in (it does by default)
    // and answers SIGN_IN_REQUIRED, which shows a sign-in link below.
    if (!account && !/^\S+@\S+\.\S+$/.test(form.email.trim())) {
      setCouponNeedsSignIn(true);
      setCouponMsg('Coupons are personal: sign in with the email it was sent to, and it applies here.');
      return;
    }
    setCheckingCoupon(true);
    setCouponMsg(null);
    setCouponNeedsSignIn(false);
    try {
      // Buying from a partner shop: the coupon must be that shop's (doc/18), priced on that one item.
      const r = await post<{ code: string; percentOff: number; discountPaise: number }>('/coupons/preview', {
        city, email: form.email.trim(), code, ...(partner ? { sellerId: partner.sellerId, productId: partner.productId } : {}),
      });
      setCoupon(r);
      rememberCoupon(r.code);
    } catch (e) {
      setCoupon(null);
      setCouponMsg((e as Error).message);
      setCouponNeedsSignIn(e instanceof ApiError && e.code === 'SIGN_IN_REQUIRED');
    } finally {
      setCheckingCoupon(false);
    }
  };

  // Back from signing in with a coupon link waiting: the email is now the account's, so check it.
  const autoApplied = useRef(false);
  useEffect(() => {
    if (account && couponInput.trim() && !coupon && !autoApplied.current && (cart?.items.length || partner)) {
      autoApplied.current = true;
      void applyCoupon();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, cart?.items.length, partner?.sellerId]);

  // Arriving from a product page's "Buy from <partner>": /checkout?seller=ID&product=ID
  const sellerParam = Number(params.get('seller'));
  const productParam = Number(params.get('product'));
  useEffect(() => {
    if (!city || !sellerParam || !productParam) return;
    let cancelled = false;
    Promise.all([
      api<{ items: Offer[] }>(`/offers?productId=${productParam}&city=${city}`),
      api<ProductDetail>(`/products/${productParam}`),
    ]).then(([o, p]) => {
      const offer = o.items.find((x) => x.sellerId === sellerParam);
      if (cancelled) return;
      if (offer) setPartner({ sellerId: offer.sellerId, sellerName: offer.sellerName, productId: p.productId, productName: p.name, pricePaise: offer.pricePaise });
      else setError({ message: `That seller has sold out of ${p.name}.` });
    }, () => {});
    return () => {
      cancelled = true;
    };
  }, [city, sellerParam, productParam]);

  if (!city) return null;
  if (!partner && !sellerParam && cart && cart.items.length === 0 && !error) {
    return (
      <main className="shell page narrow">
        <div className="box empty">
          <p>Your {cityName(city)} cart is empty.</p>
          <Link to="/shop" className="btn btn-primary">Start shopping</Link>
        </div>
      </main>
    );
  }

  const customer = () => ({ name: form.name.trim(), email: form.email.trim(), ...(form.phone ? { phone: form.phone.trim() } : {}) });

  /** Reserve → pay → confirm, or release on close. Shared by cart and partner purchases. */
  const run = async (reserve: () => Promise<CheckoutResponse>, onReleased: () => void, onConfirmed?: () => Promise<void>) => {
    if (submitting) return;
    setPhase('reserving');
    setError(null);
    setInfo(null);
    try {
      const r = await reserve();
      void refresh();
      if (r.status !== 'pending_payment' || !r.payment) {
        await onConfirmed?.();
        if (r.discountPaise) forgetCoupon(); // spent
        navigate(`/orders/${r.orderId}`);
        return;
      }

      setPhase('paying');
      const outcome = await payWithRazorpay(r.payment, { orderNumber: r.orderNumber, ...customer() });
      if (!outcome.ok) {
        await post('/payments/cancel', { orderId: r.orderId }).catch(() => {});
        key.current = uuid();
        void refresh();
        onReleased();
        setInfo(
          outcome.lastError
            ? `Payment didn't go through (${outcome.lastError}). Nothing was charged.`
            : 'Payment cancelled. Nothing was charged.',
        );
        setPhase('idle');
        return;
      }

      setPhase('confirming');
      await post('/payments/verify', {
        orderId: r.orderId,
        gatewayOrderId: outcome.proof.razorpay_order_id,
        paymentId: outcome.proof.razorpay_payment_id,
        signature: outcome.proof.razorpay_signature,
      });
      await onConfirmed?.();
      if (r.discountPaise) forgetCoupon(); // spent
      navigate(`/orders/${r.orderId}`);
    } catch (err) {
      setPhase('idle');
      key.current = uuid();
      if (err instanceof ApiError && err.code === 'OUT_OF_STOCK') {
        const items = (err.details as { items?: ShortItem[] } | undefined)?.items;
        setError({ message: err.message, items });
        setOffersRound((n) => n + 1); // refresh partner stock
        void refresh();
        // The message and the partner offers sit above the form: bring them into view.
        requestAnimationFrame(() => scrollToTop());
      } else if (err instanceof ApiError && err.code === 'COUPON_INVALID') {
        setCoupon(null);
        setCouponMsg(err.message);
      } else if (err instanceof ApiError && err.code === 'VALIDATION') {
        const issues = (err.details as { issues?: { path: string; message: string }[] } | undefined)?.issues ?? [];
        setError({ message: issues.length ? issues.map((i) => `${i.path.replace('customer.', '')}: ${i.message}`).join(', ') : err.message });
      } else {
        setError({ message: (err as Error).message });
      }
    }
  };

  const payCart = () =>
    run(
      () => post<CheckoutResponse>('/checkout', {
        city, idempotencyKey: key.current, customer: customer(), ...(coupon ? { couponCode: coupon.code } : {}),
      }),
      () => setInfo(null),
    );

  const payPartner = (p: PartnerPick) =>
    run(
      () => post<CheckoutResponse>('/checkout/offer', {
        city, idempotencyKey: key.current, customer: customer(), sellerId: p.sellerId, productId: p.productId, qty: 1,
        ...(coupon ? { couponCode: coupon.code } : {}),
      }),
      () => setBusySeller(null),
      // Bought elsewhere: drop our sold-out line from the cart so it doesn't linger.
      async () => {
        await del(`/cart/items/${p.productId}?city=${city}`).catch(() => {});
      },
    ).finally(() => setBusySeller(null));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (partner) void payPartner(partner);
    else void payCart();
  };

  /** "Buy from <partner>" in the sold-out panel: keep the details already typed in. */
  const buyFromPartner = (offer: Offer, productName: string) => {
    if (!formRef.current?.reportValidity()) {
      setInfo('Add your name and email above, then choose a seller.');
      return;
    }
    const pick = { sellerId: offer.sellerId, sellerName: offer.sellerName, productId: offer.productId, productName, pricePaise: offer.pricePaise };
    setPartner(pick);
    setBusySeller(offer.sellerId);
    void payPartner(pick);
  };

  const total = partner ? partner.pricePaise - (coupon?.discountPaise ?? 0) : cart ? cart.subtotalPaise - (coupon?.discountPaise ?? 0) : undefined;
  // Signing in to use a coupon comes back to the same checkout (cart, or the same shop's item).
  const signInNext = `/checkout?${new URLSearchParams({
    ...(partner ? { seller: String(partner.sellerId), product: String(partner.productId) } : {}), coupon: couponInput.trim(),
  })}`;

  return (
    <main className="shell page narrow">
      <h1 className="page-title">Checkout <span className="muted">{cityName(city)}</span></h1>

      {error && (
        <div className="notice error" role="alert">
          <strong>{error.message}</strong>
          {error.items && (
            <ul className="short-list">
              {error.items.map((i) => (
                <li key={i.productId}>
                  {i.name}: you wanted {i.requested}, {i.available === 0 ? 'none left' : `${i.available} left`} in {cityName(city)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* The rescue: same item from partner retailers, so the shopper can still buy here. */}
      {error?.items?.map((i) => (
        <PartnerOffers
          key={`${i.productId}-${offersRound}`}
          productId={i.productId}
          city={city}
          title={`Same ${i.name}, from other sellers in ${cityName(city)}`}
          busySellerId={busySeller}
          onBuy={(o) => buyFromPartner(o, i.name)}
          emptyText={`No partner seller has ${i.name} in ${cityName(city)} right now.`}
        />
      ))}
      {error?.items && <Link to="/cart" className="btn btn-sm">Back to cart</Link>}

      {info && <div className="notice" role="status">{info}</div>}
      {submitting && (
        <div className="notice pay-status" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" /> {PHASE_LABEL[phase]}
          {phase === 'paying' && <span className="muted"> Your item is held for you while you pay.</span>}
        </div>
      )}

      <div className="checkout-grid">
        <form className="box form" onSubmit={onSubmit} ref={formRef}>
          <label>
            Name
            <input required minLength={2} maxLength={80} autoComplete="name" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            Email <span className="muted small">{account ? '(your account)' : '(for your confirmation)'}</span>
            <input required type="email" maxLength={120} autoComplete="email" value={form.email} readOnly={Boolean(account)}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              // A code from a coupon link is waiting: check it as soon as the email is in.
              onBlur={() => { if (couponInput.trim() && !coupon && !couponMsg) void applyCoupon(); }} />
          </label>
          {account ? (
            <p className="muted small signed-in-as">Signed in as {account.email}. This order will be in <Link to="/account">your orders</Link> on every device.</p>
          ) : (
            <p className="muted small signed-in-as">Shopping as a guest. <Link to={`/signin?next=${encodeURIComponent('/checkout' + window.location.search)}`}>Sign in</Link> to keep your cart and orders on every device (optional).</p>
          )}
          <label>
            Phone <span className="muted small">(optional, 10 digits)</span>
            <input inputMode="numeric" pattern="\d{10}" maxLength={10} autoComplete="tel-national" value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, '') })} />
          </label>
          {(
            <div className="coupon-row">
              <label>
                Coupon code <span className="muted small">(optional)</span>
                <span className="coupon-input">
                  <input value={couponInput} maxLength={40} autoCapitalize="characters" spellCheck={false} data-no-track
                    onChange={(e) => { setCouponInput(e.target.value.toUpperCase()); setCoupon(null); setCouponMsg(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void applyCoupon(); } }} />
                  <button type="button" className="btn btn-sm" onClick={() => void applyCoupon()}
                    disabled={!couponInput.trim() || checkingCoupon || submitting}>
                    {checkingCoupon ? 'Checking…' : coupon ? 'Applied' : 'Apply'}
                  </button>
                </span>
              </label>
              {coupon && <p className="coupon-ok small">{coupon.percentOff}% off applied: you save {inr(coupon.discountPaise)}.</p>}
              {couponMsg && (
                <p className="coupon-bad small" role="alert">
                  {couponMsg}
                  {couponNeedsSignIn && (
                    <> <Link to={`/signin?next=${encodeURIComponent(signInNext)}`}>Sign in to use it</Link></>
                  )}
                </p>
              )}
            </div>
          )}
          <button className="btn btn-primary btn-block" disabled={submitting || (!partner && !cart?.items.length)}>
            {submitting ? PHASE_LABEL[phase] : `Pay${total ? ` ${inr(total)}` : ''}${partner ? ` to ${partner.sellerName}` : ''}`}
          </button>
          <p className="muted small">
            Payments run in Razorpay Test Mode: no real money moves. Choose Netbanking, any bank, then Success.
          </p>
        </form>

        <aside className="box order-summary">
          <h2 className="small-title">Order summary</h2>
          {partner ? (
            <>
              <ul>
                <li>
                  <span>1 × {partner.productName}<br /><small className="muted">Sold by {partner.sellerName}</small></span>
                  <span>{inr(partner.pricePaise)}</span>
                </li>
              </ul>
              {coupon && (
                <div className="summary-row discount"><span>Coupon {coupon.code}</span><span>−{inr(coupon.discountPaise)}</span></div>
              )}
              <div className="summary-row"><span>Total</span><span className="price">{inr(partner.pricePaise - (coupon?.discountPaise ?? 0))}</span></div>
              {cart && cart.items.length > 0 && (
                <button type="button" className="link-btn small" onClick={() => { setPartner(null); navigate('/checkout', { replace: true }); }}>
                  Pay for my cart instead
                </button>
              )}
            </>
          ) : cart && (
            <>
              <ul>
                {cart.items.map((i) => (
                  <li key={i.productId}>
                    <span>{i.qty} × {i.name}</span>
                    <span>{inr(i.qty * i.unitPricePaise)}</span>
                  </li>
                ))}
              </ul>
              {coupon && (
                <div className="summary-row discount"><span>Coupon {coupon.code}</span><span>−{inr(coupon.discountPaise)}</span></div>
              )}
              <div className="summary-row"><span>Total</span><span className="price">{inr(cart.subtotalPaise - (coupon?.discountPaise ?? 0))}</span></div>
            </>
          )}
        </aside>
      </div>
    </main>
  );
}
