import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { cityName, inr, type CityCode } from '../api';
import { useCart, useCity, useToast } from '../state';
import { staggerIn, useGsap } from '../motion';
import { ProductImage } from '../components/ProductImage';
import { Stepper } from '../components/ui';
import { CouponBanner } from '../components/CouponBanner';
import { CartAddOns } from '../components/BoughtTogether';

/** Cart (doc/06 §2). Availability here is a hint; checkout is the only place stock is allocated. */
export function CartPage() {
  const { city, setCity } = useCity();
  const { cart, setQty, remove } = useCart();
  const { toast } = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  const pageRef = useRef<HTMLElement>(null);
  const loaded = cart !== null;
  // Lines cascade in once when the cart first loads (not on every 5 s refresh).
  useGsap(() => loaded && staggerIn('.cart-line, .summary'), [loaded], pageRef);

  const run = async (productId: number, fn: () => Promise<void>) => {
    setBusy(productId);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!city) return null;
  if (!cart) return <main className="shell page"><div className="box skeleton" style={{ height: 160 }} /></main>;

  return (
    <main className="shell page narrow" ref={pageRef}>
      <h1 className="page-title">Your cart <span className="muted">· {cityName(city)}</span></h1>
      <CouponBanner />

      {cart.otherCityCarts.map((o) => (
        <div key={o.city} className="notice">
          You also have {o.itemCount} {o.itemCount === 1 ? 'item' : 'items'} in your {cityName(o.city)} cart ·{' '}
          <button className="link-btn" onClick={() => setCity(o.city as CityCode)}>switch to {cityName(o.city)}</button>
        </div>
      ))}

      {cart.items.length === 0 ? (
        <div className="box empty">
          <p>Your {cityName(city)} cart is empty.</p>
          <Link to="/shop" className="btn btn-primary">Start shopping</Link>
        </div>
      ) : (
        <>
          <ul className="cart-lines box">
            {cart.items.map((i) => (
              <li key={i.productId} className="cart-line">
                <Link to={`/p/${i.productId}`} className="cart-thumb" aria-hidden="true" tabIndex={-1}>
                  <ProductImage imageKey={i.imageKey} productId={i.productId} sku={i.sku} name={i.name} />
                </Link>
                <div className="cart-info">
                  <Link to={`/p/${i.productId}`} className="card-name">{i.name}</Link>
                  <span className="price">{inr(i.unitPricePaise)}</span>
                  {i.available === 0 ? (
                    <span className="warn">Sold out in {cityName(city)}. Remove it to check out.</span>
                  ) : i.shortBy > 0 ? (
                    <span className="warn">Only {i.available} left in {cityName(city)}. We’ll confirm at checkout.</span>
                  ) : null}
                </div>
                <div className="cart-controls">
                  <Stepper
                    value={i.qty}
                    max={10}
                    disabled={busy === i.productId}
                    onChange={(n) => run(i.productId, () => setQty(i.productId, n))}
                  />
                  <button className="link-btn" onClick={() => run(i.productId, () => remove(i.productId))} disabled={busy === i.productId}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="summary box">
            <div className="summary-row">
              <span>Subtotal</span>
              <span className="price price-lg">{inr(cart.subtotalPaise)}</span>
            </div>
            <p className="muted small">Stock is reserved only when you place the order.</p>
            <Link to="/checkout" className="btn btn-primary btn-block">Checkout</Link>
          </div>
          <CartAddOns ids={cart.items.map((i) => i.productId)} city={city} />
        </>
      )}
    </main>
  );
}
