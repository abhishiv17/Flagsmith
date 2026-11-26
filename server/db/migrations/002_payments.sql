-- Payments (Razorpay Test Mode): checkout reserves stock and creates a *pending* order; the order is
-- confirmed only after the payment is verified, or released (stock returned) if payment fails,
-- is cancelled, or the hold expires. Additive only: existing code keeps working unchanged.
--
-- orders.status values: 'confirmed' (default, as before) | 'pending_payment' | 'cancelled'

ALTER TABLE orders ADD COLUMN IF NOT EXISTS session_id         text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cart_id            uuid;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS gateway_order_id   text UNIQUE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS gateway_payment_id text UNIQUE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reserved_until     timestamptz;

-- Finds expired holds quickly (the sweep runs on every checkout).
CREATE INDEX IF NOT EXISTS orders_pending_hold ON orders (reserved_until) WHERE status = 'pending_payment';
