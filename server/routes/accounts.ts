import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse } from '../lib/http.js';
import { currentAccount, myOrders, requestCode, signIn, signOut, type Account } from '../domain/accounts.js';
import { createAlert, deleteAlert, listAlerts } from '../domain/alerts.js';
import { shopForEmail } from '../domain/retailers.js';
import { CityCode } from '../lib/http.js';
import type { Request } from 'express';

/** Optional shopper accounts (doc/17): passwordless email codes. Guests never need these. */
export const accounts = Router();

const Email = z.email().max(254);

accounts.post('/auth/code', async (req, res) => {
  const { email } = parse(z.object({ email: Email }), req.body);
  res.json(await requestCode(req, email));
});

accounts.post('/auth/verify', async (req, res) => {
  const b = parse(
    z.object({ email: Email, code: z.string().regex(/^\d{6}$/, '6-digit code'), name: z.string().trim().min(2).max(80).optional() }),
    req.body,
  );
  const acct = await signIn(req, res, b.email, b.code, b.name);
  res.json({ account: acct, retailer: await shopForEmail(acct.email) });
});

accounts.post('/auth/logout', async (req, res) => {
  await signOut(req, res);
  res.json({ ok: true });
});

accounts.get('/auth/me', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const account = await currentAccount(req);
  // A shop owner (doc/18) also gets their shop, so the header can offer "My shop".
  res.json({ account, retailer: account ? await shopForEmail(account.email) : null });
});

accounts.get('/me/orders', async (req, res) => {
  const acct = await currentAccount(req);
  if (!acct) throw new HttpError(401, 'UNAUTHORIZED', 'Sign in to see your orders.');
  res.set('Cache-Control', 'no-store');
  res.json({ items: await myOrders(acct) });
});

/** Alerts need someone to tell, so they need an account. */
async function requireAccount(req: Request): Promise<Account> {
  const acct = await currentAccount(req);
  if (!acct) throw new HttpError(401, 'SIGN_IN_REQUIRED', 'Sign in so we know who to tell when it’s back.');
  return acct;
}

/** "Notify me when it's back" (doc/17). */
accounts.get('/me/alerts', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ items: await listAlerts(await requireAccount(req)) });
});

accounts.post('/me/alerts', async (req, res) => {
  const b = parse(z.object({ productId: z.number().int().positive(), city: CityCode }), req.body);
  res.status(201).json({ items: await createAlert(await requireAccount(req), b.productId, b.city) });
});

accounts.delete('/me/alerts/:id', async (req, res) => {
  const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
  res.json({ items: await deleteAlert(await requireAccount(req), id) });
});
