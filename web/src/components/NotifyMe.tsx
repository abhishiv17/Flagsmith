import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cityName } from '../api';
import { useAccount } from '../state';
import { EVENTS, trackConversion } from '../experiments';

/**
 * "Notify me when it's back in <city>" (doc/17). Guests are sent to sign in first (an alert needs
 * someone to tell) and come straight back. The notifier marks the alert when stock returns.
 */
export function NotifyMe({ productId, city, name }: { productId: number; city: string; name: string }) {
  const { account, alerts, addAlert } = useAccount();
  const { pathname, search } = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = alerts.find((a) => a.productId === productId && a.city === city && !a.notifiedAt);
  const here = cityName(city);

  if (account === undefined) return null;
  if (!account) {
    return (
      <Link className="btn btn-ghost btn-sm notify-btn" to={`/signin?next=${encodeURIComponent(pathname + search)}`}>
        🔔 Notify me when it’s back in {here} <span className="muted small">(sign in)</span>
      </Link>
    );
  }
  if (waiting) {
    return (
      <p className="notify-set small" role="status">
        🔔 We’ll tell you the moment {name} is back in {here}. <Link to="/account">Your alerts</Link>
      </p>
    );
  }
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm notify-btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await addAlert(productId, city);
            trackConversion(EVENTS.backInStockAlert); // sold out, but the shopper didn't leave empty-handed
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        🔔 {busy ? 'Saving…' : `Notify me when it’s back in ${here}`}
      </button>
      {error && <p className="coupon-bad small" role="alert">{error}</p>}
    </>
  );
}
