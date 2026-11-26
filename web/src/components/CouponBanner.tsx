import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { forgetCoupon, rememberCoupon, savedCoupon, type PublicCoupon } from '../coupon';
import { useAccount } from '../state';

/**
 * Shown when a shopper arrives from a coupon link (?coupon=CODE), and on later pages until they use it.
 * Only the offer and this signed-in account's eligibility are shown; the recipient stays private.
 */
export function CouponBanner() {
  const [params] = useSearchParams();
  const { account } = useAccount();
  const location = useLocation();
  const fromUrl = params.get('coupon')?.trim().toUpperCase() ?? '';
  const [c, setC] = useState<PublicCoupon | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (account === undefined) return;
    const code = fromUrl || savedCoupon();
    setC(null);
    setMissing(false);
    if (!code) return;
    let live = true;
    api<PublicCoupon>(`/coupons/${encodeURIComponent(code)}`)
      .then((r) => {
        if (!live) return;
        setC(r);
        if (r.status === 'open' && r.eligible) rememberCoupon(r.code);
        else if (savedCoupon() === code) forgetCoupon();
      })
      .catch(() => live && fromUrl && setMissing(true));
    return () => { live = false; };
  }, [fromUrl, account?.email]);

  if (missing) return <div className="notice coupon-banner" role="status">That coupon link isn’t valid. Check you copied all of it.</div>;
  if (!c) return null;
  if (c.status !== 'open') {
    return fromUrl ? (
      <div className="notice coupon-banner" role="status">
        Coupon <strong className="mono">{c.code}</strong> has {c.status === 'used' ? 'already been used' : 'expired'}.
      </div>
    ) : null;
  }
  if (c.eligible === false) return (
    <div className="notice coupon-banner" role="status">
      Coupon <strong className="mono">{c.code}</strong> belongs to another account. Sign in with the account it was sent to before using it.
    </div>
  );
  if (c.eligible === null) return (
    <div className="notice coupon-banner" role="status">
      Coupon <strong className="mono">{c.code}</strong> is personal.{' '}
      <Link to={`/signin?next=${encodeURIComponent(location.pathname + location.search)}`}>Sign in with the account it was sent to</Link> to use it.
    </div>
  );
  const until = new Date(c.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  if (c.sellerId) {
    // A shop's own coupon: it only works when buying from that shop, signed in as the customer it was given to.
    const buy = c.productId ? `/checkout?${new URLSearchParams({ seller: String(c.sellerId), product: String(c.productId), coupon: c.code })}` : null;
    return (
      <div className="notice coupon-banner ok" role="status">
        <span aria-hidden="true">🎟</span>
        <span>
          <strong>{c.sellerName} gave you {c.percentOff}% off</strong> with coupon <strong className="mono">{c.code}</strong>, until {until}.
          {' '}It works when you buy from {c.sellerName}, signed in with your email
          {buy ? <>: <Link to={buy}>buy {c.productName ?? 'it'} from {c.sellerName}</Link>.</> : '.'}
        </span>
      </div>
    );
  }
  return (
    <div className="notice coupon-banner ok" role="status">
      <span aria-hidden="true">🎟</span>
      <span>
        <strong>{c.percentOff}% off your order</strong> with coupon <strong className="mono">{c.code}</strong>, until {until}.
        {' '}It’s filled in for you at <Link to="/checkout">checkout</Link>; use the email it was sent to.
      </span>
    </div>
  );
}
