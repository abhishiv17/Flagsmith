import type { Request } from 'express';
import { z } from 'zod';

/** Error shape for every non-2xx response (doc/05). */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: 'VALIDATION' | 'NOT_FOUND' | 'OUT_OF_STOCK' | 'CART_EMPTY' | 'SEARCH_UNAVAILABLE' | 'UNAUTHORIZED' | 'SIGN_IN_REQUIRED' | 'INTERNAL' | 'COUPON_INVALID' | 'BUSY' | 'ALREADY_REVIEWED',
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new HttpError(400, 'VALIDATION', 'Invalid request', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export const CityCode = z.enum(['BLR', 'MUM', 'DEL']);
export type CityCode = z.infer<typeof CityCode>;

/** Guest session id set by the cookie middleware in app.ts. */
export function sessionId(req: Request): string {
  const sid = req.cookies?.sh_sid as string | undefined;
  if (!sid) throw new HttpError(400, 'VALIDATION', 'Missing session');
  return sid;
}
