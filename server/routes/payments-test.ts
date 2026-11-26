import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config.js';
import { HttpError, parse } from '../lib/http.js';
import { createTestOrder, getTestOrder, getTestOrderPayments, publicTestKey } from '../lib/razorpay-test.js';

/** Gateway connectivity checks only. These routes never create a StockHop order or change stock. */
export const paymentsTest = Router();

paymentsTest.use('/payments/test', (req, _res, next) => {
  if (!env.ADMIN_TOKEN || req.get('x-admin-token') !== env.ADMIN_TOKEN) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Admin token required.');
  }
  next();
});

paymentsTest.post('/payments/test/orders', async (req, res) => {
  const { amountPaise } = parse(z.object({ amountPaise: z.number().int().min(100).max(100_000) }), req.body);
  const receipt = `sh-test-${randomUUID()}`;
  const order = await createTestOrder(amountPaise, receipt);
  res.status(201).json({
    testMode: true,
    keyId: publicTestKey(),
    gatewayOrderId: order.id,
    amountPaise: order.amount,
    amountPaidPaise: order.amount_paid,
    attempts: order.attempts,
    status: order.status,
    receipt: order.receipt,
  });
});

paymentsTest.get('/payments/test/orders/:orderId', async (req, res) => {
  const { orderId } = parse(z.object({ orderId: z.string().regex(/^order_[A-Za-z0-9]+$/) }), req.params);
  const order = await getTestOrder(orderId);
  res.json({
    testMode: true,
    gatewayOrderId: order.id,
    amountPaise: order.amount,
    amountPaidPaise: order.amount_paid,
    amountDuePaise: order.amount_due,
    attempts: order.attempts,
    status: order.status,
  });
});

paymentsTest.get('/payments/test/orders/:orderId/payments', async (req, res) => {
  const { orderId } = parse(z.object({ orderId: z.string().regex(/^order_[A-Za-z0-9]+$/) }), req.params);
  const payments = await getTestOrderPayments(orderId);
  res.json({
    testMode: true,
    gatewayOrderId: orderId,
    attemptsReturned: payments.count,
    payments: payments.items.map((payment) => ({
      paymentId: payment.id,
      status: payment.status,
      amountPaise: payment.amount,
      method: payment.method,
      createdAt: payment.created_at,
    })),
  });
});
