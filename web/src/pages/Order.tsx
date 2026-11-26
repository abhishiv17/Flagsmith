import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, cityName, inr, type Order } from '../api';
import { usePoll } from '../hooks';
import { drawCheck, orderIntro, useGsap } from '../motion';
import { ProductImage } from '../components/ProductImage';
import { useAccount } from '../state';

/**
 * Order confirmation. "Confirmation sent ✓" appears only once the notifier Kafka consumer has
 * actually processed the OrderPlaced event: a visible proof the event pipeline ran.
 */
export function OrderPage() {
  const { orderId } = useParams();
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [polls, setPolls] = useState(0);
  const waiting = !order?.confirmationSent && polls < 30;
  const pageRef = useRef<HTMLElement>(null);
  const checkRef = useRef<SVGPathElement>(null);
  const loadedId = order?.orderId ?? null;
  const sent = Boolean(order?.confirmationSent);

  useGsap(() => loadedId !== null && orderIntro(), [loadedId], pageRef);
  // The tick draws itself the moment the notifier consumer's confirmation lands.
  useEffect(() => {
    if (sent) drawCheck(checkRef.current);
  }, [sent]);

  usePoll(
    async () => {
      try {
        setOrder(await api<Order>(`/orders/${orderId}`));
        setError(null);
      } catch (e) {
        setError(e instanceof ApiError && e.status === 404 ? 'We couldn’t find that order.' : (e as Error).message);
      }
      setPolls((n) => n + 1);
    },
    1000,
    waiting,
  );

  if (error && !order) return <main className="shell page"><div className="notice error" role="alert">{error}</div></main>;
  if (!order) return <main className="shell page narrow"><div className="box skeleton" style={{ height: 220 }} /></main>;

  return (
    <main className="shell page narrow" ref={pageRef}>
      <div className="box order-hero">
        <span className="chip">
          {order.status === 'confirmed' ? 'Order confirmed' : order.status === 'pending_payment' ? 'Awaiting payment' : 'Order cancelled'}
        </span>
        <h1 className="order-no" aria-label={order.orderNumber}>
          {[...order.orderNumber].map((ch, i) => (
            <span key={i} className="ch" aria-hidden="true" style={{ display: 'inline-block' }}>{ch}</span>
          ))}
        </h1>
        <p className="muted">{cityName(order.city)} · {new Date(order.createdAt).toLocaleString('en-IN')}</p>
        {order.paymentId && <p className="muted small">Paid with Razorpay (test mode), payment {order.paymentId}</p>}
        {order.status === 'cancelled' && (
          <p>This order wasn’t paid for, so it was cancelled and the items went back on the shelf. Nothing was charged.</p>
        )}
        {order.status === 'confirmed' && (
        <div className={`confirm ${order.confirmationSent ? 'sent' : ''}`} aria-live="polite">
          {order.confirmationSent ? (
            <>
              <svg className="check" viewBox="0 0 24 24" aria-hidden="true"><path ref={checkRef} d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              Confirmation sent to {order.confirmationTo}
            </>
          ) : polls < 30 ? (
            <><span className="spinner" aria-hidden="true" /> Sending confirmation…</>
          ) : (
            <>Confirmation is queued and will be sent shortly.</>
          )}
        </div>
        )}
      </div>

      <ul className="cart-lines box">
        {order.items.map((i) => (
          <li key={i.productId} className="cart-line">
            <div className="cart-thumb" aria-hidden="true">
              <ProductImage imageKey={i.imageKey} productId={i.productId} sku={i.sku} name={i.name} />
            </div>
            <div className="cart-info">
              <span className="card-name">{i.name}</span>
              <span className="muted">{i.qty} × {inr(i.unitPricePaise)}</span>
              <span className="muted small">Sold by {i.seller ?? 'StockHop'}</span>
            </div>
            <span className="price">{inr(i.qty * i.unitPricePaise)}</span>
          </li>
        ))}
      </ul>
      <div className="summary box">
        <div className="summary-row"><span>Total</span><span className="price price-lg">{inr(order.totalPaise)}</span></div>
        <AccountNudge />
        <Link to="/shop" className="btn btn-block">Keep shopping</Link>
      </div>
    </main>
  );
}

/** Guests: one line offering an account (optional). Orders link to the email, so past ones show up too. */
function AccountNudge() {
  const { account } = useAccount();
  if (account !== null) return null;
  return (
    <p className="muted small account-nudge">
      Want this order on every device? <Link to="/signin?next=/account">Sign in with the email you used</Link>: no password, and your past orders come along.
    </p>
  );
}
