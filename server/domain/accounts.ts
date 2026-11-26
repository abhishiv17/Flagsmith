import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../config.js';
import { getPool, withTx } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { log, maskEmail } from '../lib/log.js';
import { orderNumber } from '../lib/events.js';

/**
 * Optional shopper accounts (doc/17). Passwordless: the shopper asks for a 6-digit code for their
 * email, types it back, and gets a session cookie. An account is a `customers` row with a verified
 * email, so past orders under that email are theirs straight away.
 *
 * Guests are untouched: nothing on the site requires signing in except redeeming a loyalty coupon,
 * which is tied to an email and so needs proof the shopper owns it.
 *
 * While signed in, the cart and payment holds belong to the account (`shopperKey` = "acct:<id>")
 * instead of the browser, so the same cart shows on every device and one person can't claim the
 * last unit twice from two tabs or laptops.
 */

export const AUTH_COOKIE = 'sh_auth';
// Demo mode (code shown on screen, nothing sent): no limits at all, so pitch logins never lock out.
const CODE_MINUTES = env.AUTH_DEMO_CODES ? 24 * 60 : 10;
const CODE_MAX_ATTEMPTS = env.AUTH_DEMO_CODES ? Number.MAX_SAFE_INTEGER : 5;
const SESSION_DAYS = 30;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const codeHash = (email: string, code: string) =>
  env.AUTH_SECRET ? createHmac('sha256', env.AUTH_SECRET).update(`${email}:${code}`).digest('hex') : sha256(`stockhop:${email}:${code}`);
const ipHash = (req: Request) => sha256(`stockhop-ip:${req.ip ?? ''}`).slice(0, 32);
export const normEmail = (e: string) => e.trim().toLowerCase();

export interface Account { id: string; name: string; email: string; phone: string | null }

/* ---------------- codes ---------------- */

/**
 * Ask for a sign-in code. With real email, rate-limited per email and per network. In demo mode
 * (AUTH_DEMO_CODES) the code is shown on screen and no email is sent, so there is nothing to protect:
 * unlimited sign-ins, so demo logins never lock out during a pitch.
 */
export async function requestCode(req: Request, rawEmail: string): Promise<{ sent: true; demoCode?: string; expiresInMinutes: number }> {
  const email = normEmail(rawEmail);
  const ip = ipHash(req);
  const pool = getPool();
  const { rows } = await pool.query<{ last_s: number | null; per_email: string; per_ip: string }>(
    `SELECT (SELECT extract(epoch FROM now() - max(created_at)) FROM sign_in_codes WHERE email = $1) AS last_s,
            (SELECT count(*) FROM sign_in_codes WHERE email = $1 AND created_at > now() - interval '1 hour') AS per_email,
            (SELECT count(*) FROM sign_in_codes WHERE ip_hash = $2 AND created_at > now() - interval '1 hour') AS per_ip`,
    [email, ip],
  );
  const r = rows[0]!;
  if (!env.AUTH_DEMO_CODES) {
    if (r.last_s != null && Number(r.last_s) < 30) {
      throw new HttpError(429, 'BUSY', `We just sent a code. You can ask for another in ${Math.ceil(30 - Number(r.last_s))} s.`);
    }
    if (Number(r.per_email) >= 5 || Number(r.per_ip) >= 30) {
      throw new HttpError(429, 'BUSY', 'Too many codes asked for. Try again in an hour.');
    }
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await pool.query(
    `INSERT INTO sign_in_codes (email, code_hash, ip_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4::int))`,
    [email, codeHash(email, code), ip, CODE_MINUTES],
  );
  // Email is simulated in this build (like order confirmations): logged, never the code itself.
  log.info('accounts: sign-in code issued', { to: maskEmail(email) });
  return { sent: true, expiresInMinutes: CODE_MINUTES, ...(env.AUTH_DEMO_CODES ? { demoCode: code } : {}) };
}

/** Check a code; on success create (or verify) the customer and a session. */
async function verifyCode(rawEmail: string, code: string, name?: string): Promise<Account> {
  const email = normEmail(rawEmail);
  return withTx(async (tx) => {
    // Demo mode: any of this email's recent codes works (asked twice? either code signs in).
    const { rows } = await tx.query<{ id: string; code_hash: string; attempts: number }>(
      `SELECT id, code_hash, attempts FROM sign_in_codes
        WHERE email = $1 AND used_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT $2 FOR UPDATE`,
      [email, env.AUTH_DEMO_CODES ? 50 : 1],
    );
    const got0 = Buffer.from(codeHash(email, code), 'hex');
    const c = (env.AUTH_DEMO_CODES && rows.find((r) => r.code_hash === got0.toString('hex'))) || rows[0];
    if (!c || c.attempts >= CODE_MAX_ATTEMPTS) {
      throw new HttpError(401, 'UNAUTHORIZED', 'That code has expired or was used up. Ask for a new one.');
    }
    const want = Buffer.from(c.code_hash, 'hex');
    const got = Buffer.from(codeHash(email, code), 'hex');
    if (want.length !== got.length || !timingSafeEqual(want, got)) {
      // The attempt is counted by signIn() outside this (rolled-back) transaction.
      const left = CODE_MAX_ATTEMPTS - c.attempts - 1;
      throw Object.assign(new HttpError(401, 'UNAUTHORIZED',
        env.AUTH_DEMO_CODES ? 'That code isn’t right. Check the code shown on screen and try again.'
          : left > 0 ? `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong tries. Ask for a new code.'),
      { countAttempt: true });
    }
    await tx.query('UPDATE sign_in_codes SET used_at = now() WHERE id = $1', [c.id]);
    const fallbackName = email.split('@')[0]!.replace(/[._-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()).slice(0, 80) || 'Shopper';
    const cust = await tx.query<Account>(
      `INSERT INTO customers (name, email, email_verified_at, last_sign_in_at) VALUES ($1, $2, now(), now())
       ON CONFLICT (email) DO UPDATE SET
         name = CASE WHEN $3::boolean THEN EXCLUDED.name ELSE customers.name END,
         email_verified_at = COALESCE(customers.email_verified_at, now()), last_sign_in_at = now()
       RETURNING id, name, email, phone`,
      [name?.trim() || fallbackName, email, Boolean(name?.trim())],
    );
    return cust.rows[0]!;
  });
}

/* ---------------- sessions ---------------- */

const cookieOpts = (req: Request) => ({
  httpOnly: true, sameSite: 'lax' as const, secure: req.secure, maxAge: SESSION_DAYS * 24 * 3600 * 1000, path: '/',
});

/** The signed-in account for this request, or null. Cached on the request. */
export async function currentAccount(req: Request): Promise<Account | null> {
  const cached = (req as Request & { _acct?: Account | null })._acct;
  if (cached !== undefined) return cached;
  const token = req.cookies?.[AUTH_COOKIE] as string | undefined;
  let acct: Account | null = null;
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
    const { rows } = await getPool().query<Account>(
      `UPDATE account_sessions s SET last_seen_at = now()
         FROM customers c
        WHERE s.token_hash = $1 AND s.expires_at > now() AND c.id = s.customer_id
        RETURNING c.id, c.name, c.email, c.phone`,
      [sha256(token)],
    );
    acct = rows[0] ?? null;
  }
  (req as Request & { _acct?: Account | null })._acct = acct;
  return acct;
}

/** Who owns carts and payment holds: the account when signed in, otherwise the browser session. */
export async function shopperKey(req: Request): Promise<string> {
  const acct = await currentAccount(req);
  if (acct) return `acct:${acct.id}`;
  const sid = req.cookies?.sh_sid as string | undefined;
  if (!sid) throw new HttpError(400, 'VALIDATION', 'Missing session');
  return sid;
}

/**
 * Sign in: verify the code, then move this browser's guest carts (and any payment hold in progress)
 * onto the account, merging with the account's carts from other devices.
 */
export async function signIn(req: Request, res: Response, email: string, code: string, name?: string): Promise<Account> {
  let acct: Account;
  try {
    acct = await verifyCode(email, code, name);
  } catch (e) {
    // A wrong code rolled back its own tx; record the attempt separately so the 5-try limit holds.
    if ((e as { countAttempt?: boolean }).countAttempt) {
      await getPool().query(
        `UPDATE sign_in_codes SET attempts = attempts + 1
          WHERE id = (SELECT id FROM sign_in_codes WHERE email = $1 AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1)`,
        [normEmail(email)],
      );
    }
    throw e;
  }
  const token = randomBytes(32).toString('base64url');
  await getPool().query(
    `INSERT INTO account_sessions (token_hash, customer_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3::int))`,
    [sha256(token), acct.id, SESSION_DAYS],
  );
  const sid = req.cookies?.sh_sid as string | undefined;
  if (sid) await adoptGuestCarts(sid, `acct:${acct.id}`);
  res.cookie(AUTH_COOKIE, token, cookieOpts(req));
  (req as Request & { _acct?: Account | null })._acct = acct;
  log.info('accounts: signed in', { to: maskEmail(acct.email) });
  return acct;
}

export async function signOut(req: Request, res: Response) {
  const token = req.cookies?.[AUTH_COOKIE] as string | undefined;
  if (token) await getPool().query('DELETE FROM account_sessions WHERE token_hash = $1', [sha256(token)]);
  res.clearCookie(AUTH_COOKIE, { path: '/' });
}

/** Guest carts → account carts (one active cart per owner and city), plus pending payment holds. */
async function adoptGuestCarts(guestKey: string, acctKey: string) {
  await withTx(async (tx) => {
    const guest = await tx.query<{ id: string; city_code: string }>(
      `SELECT id, city_code FROM carts WHERE session_id = $1 AND status = 'active' FOR UPDATE`, [guestKey]);
    for (const g of guest.rows) {
      const mine = await tx.query<{ id: string }>(
        `SELECT id FROM carts WHERE session_id = $1 AND city_code = $2 AND status = 'active' FOR UPDATE`, [acctKey, g.city_code]);
      const target = mine.rows[0]?.id;
      if (!target) {
        await tx.query(`UPDATE carts SET session_id = $2, updated_at = now() WHERE id = $1`, [g.id, acctKey]);
        continue;
      }
      // Same product in both: keep the larger quantity (not the sum), so signing in never claims more units.
      await tx.query(
        `INSERT INTO cart_items (cart_id, product_id, qty, added_at)
         SELECT $2, product_id, qty, added_at FROM cart_items WHERE cart_id = $1
         ON CONFLICT (cart_id, product_id) DO UPDATE SET qty = GREATEST(cart_items.qty, EXCLUDED.qty)`,
        [g.id, target],
      );
      await tx.query('DELETE FROM carts WHERE id = $1', [g.id]);
      await tx.query('UPDATE carts SET updated_at = now() WHERE id = $1', [target]);
    }
    // A payment the guest started should still verify (or cancel) after signing in.
    await tx.query(`UPDATE orders SET session_id = $2 WHERE session_id = $1 AND status = 'pending_payment'`, [guestKey, acctKey]);
  });
}

/* ---------------- my orders ---------------- */

export async function myOrders(acct: Account) {
  const { rows } = await getPool().query<{
    id: string; order_no: string; city_code: string; status: string; total_paise: number; created_at: Date; items: string; first_name: string;
  }>(
    `SELECT o.id, o.order_no, o.city_code, o.status, o.total_paise, o.created_at,
            (SELECT sum(qty) FROM order_items WHERE order_id = o.id) AS items,
            (SELECT p.name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = o.id ORDER BY p.name LIMIT 1) AS first_name
       FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE c.id = $1
      ORDER BY o.created_at DESC LIMIT 50`,
    [acct.id],
  );
  return rows.map((r) => ({
    orderId: r.id, orderNumber: orderNumber(r.city_code, r.order_no), city: r.city_code, status: r.status,
    totalPaise: r.total_paise, createdAt: r.created_at, itemCount: Number(r.items ?? 0), firstItem: r.first_name,
  }));
}
