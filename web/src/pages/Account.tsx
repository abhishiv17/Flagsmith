import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, cityName, inr, type MyOrder } from '../api';
import { useAccount, useToast } from '../state';
import { ProductImage } from '../components/ProductImage';

/** Only same-site paths, so a crafted ?next= can't send someone off StockHop. */
const safeNext = (n: string | null) => (n && /^\/(?!\/)[\w\-/?=&%.]*$/.test(n) ? n : '/account');

/**
 * Passwordless sign-in (doc/17): email → 6-digit code → signed in. Optional everywhere: guests can
 * browse, race for the last unit and pay without it.
 */
export function SignIn() {
  const { account, requestCode, verify } = useAccount();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (account) navigate(next, { replace: true });
  }, [account, navigate, next]);
  useEffect(() => {
    if (step === 'code') codeRef.current?.focus();
  }, [step]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await requestCode(email.trim());
      setDemoCode(r.demoCode ?? null);
      setStep('code');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const check = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const a = await verify(email.trim(), code, name.trim() || undefined);
      toast(`Signed in as ${a.name}`);
      navigate(next, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell page auth-page">
      <div className="auth-card">
        <span className="script">Welcome back</span>
        <h1 className="page-title">Sign in</h1>
        <p className="muted">No password. We send a 6-digit code to your email. Shopping without an account works too.</p>

        {step === 'email' ? (
          <form className="form" onSubmit={send}>
            <label>
              Email
              <input required type="email" autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            {error && <p className="notice error" role="alert">{error}</p>}
            <button className="btn btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Send me a code'}</button>
          </form>
        ) : (
          <form className="form" onSubmit={check}>
            <p className="auth-sent">Code sent to <b>{email}</b>. <button type="button" className="link-btn" onClick={() => { setStep('email'); setDemoCode(null); setError(null); }}>Change</button></p>
            {demoCode && (
              <p className="auth-demo" role="status">
                <span>Demo mode: email is simulated in this build, so here’s your code</span>
                <b>{demoCode}</b>
              </p>
            )}
            <label>
              6-digit code
              <input ref={codeRef} required inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6}
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="code-input" data-no-track />
            </label>
            <label>
              Your name <span className="muted small">(first time only, optional)</span>
              <input autoComplete="name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            {error && <p className="notice error" role="alert">{error}</p>}
            <button className="btn btn-primary" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Sign in'}</button>
            <button type="button" className="link-btn small" onClick={() => void send()} disabled={busy}>Send a new code</button>
          </form>
        )}

        <ul className="auth-why">
          <li><b>Your cart on every device.</b> Start on your phone, pay on your laptop.</li>
          <li><b>Fair last units.</b> One account holds one claim, however many tabs are open.</li>
          <li><b>Your orders in one place</b>, and loyalty coupons that only you can use.</li>
        </ul>
      </div>
    </main>
  );
}

const STATUS: Record<string, string> = { confirmed: 'Confirmed', pending_payment: 'Awaiting payment', cancelled: 'Cancelled' };

export function AccountPage() {
  const { account, signOut, alerts, removeAlert } = useAccount();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [orders, setOrders] = useState<MyOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (account === null) navigate('/signin?next=/account', { replace: true });
    if (!account) return;
    api<{ items: MyOrder[] }>('/me/orders').then(
      (r) => setOrders(r.items),
      (e) => setError(e instanceof ApiError ? e.message : 'Couldn’t load your orders.'),
    );
  }, [account, navigate]);

  if (!account) return <main className="shell page"><div className="sk-line skeleton" style={{ width: '40%' }} /></main>;

  return (
    <main className="shell page account-page">
      <div className="account-head">
        <div>
          <span className="script">Hello</span>
          <h1 className="page-title">{account.name}</h1>
          <p className="muted">{account.email} <span className="chip ok">verified</span></p>
        </div>
        <button className="btn btn-ghost" onClick={async () => { await signOut(); toast('Signed out'); navigate('/'); }}>Sign out</button>
      </div>

      <h2 className="section-title">Back-in-stock alerts</h2>
      {alerts.length === 0 ? (
        <p className="muted">None yet. When something is out for you, press <b>🔔 Notify me when it’s back</b> and it shows up here.</p>
      ) : (
        <ul className="my-alerts">
          {alerts.map((a) => {
            const back = Boolean(a.notifiedAt);
            return (
              <li key={a.id} className={back ? 'my-alert is-back' : 'my-alert'}>
                <span className="my-alert-art"><ProductImage imageKey={a.imageKey} productId={a.productId} sku={a.sku} name={a.name} /></span>
                <span className="my-alert-what">
                  <b>{a.name}</b>
                  <small>
                    {back
                      ? `Back in ${cityName(a.city)} · ${a.qtyNow > 0 ? `${a.qtyNow} left now` : 'sold out again'}`
                      : `Waiting for ${cityName(a.city)} · asked ${new Date(a.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`}
                  </small>
                </span>
                {back && a.qtyNow > 0 ? (
                  <Link className="btn btn-sm btn-primary" to={`/p/${a.productId}?city=${a.city}`}>Buy now</Link>
                ) : (
                  <span className={`chip ${back ? '' : 'wait'}`}>{back ? 'Gone again' : 'Waiting'}</span>
                )}
                <button className="link-btn small" onClick={() => void removeAlert(a.id)} aria-label={`Remove alert for ${a.name}`}>Remove</button>
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="section-title">Your orders</h2>
      {error && <p className="notice error" role="alert">{error}</p>}
      {orders === null && !error && <div className="sk-line skeleton" style={{ width: '60%' }} />}
      {orders?.length === 0 && (
        <p className="muted">No orders yet. Orders you place with {account.email} show up here, from any device. <Link to="/shop">Start shopping</Link></p>
      )}
      {orders && orders.length > 0 && (
        <ul className="my-orders">
          {orders.map((o) => (
            <li key={o.orderId}>
              <Link to={`/orders/${o.orderId}`} className="my-order">
                <span className="my-order-no">{o.orderNumber}</span>
                <span className="my-order-what">
                  {o.firstItem}{o.itemCount > 1 ? ` + ${o.itemCount - 1} more` : ''}
                  <small>{cityName(o.city)} · {new Date(o.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>
                </span>
                <span className={`chip ${o.status === 'confirmed' ? 'ok' : o.status === 'cancelled' ? 'bad' : ''}`}>{STATUS[o.status] ?? o.status}</span>
                <span className="price">{inr(o.totalPaise)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
