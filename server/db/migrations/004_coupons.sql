-- Loyalty coupons (doc/16): the retailer picks a top customer on the ClickHouse dashboard and gives
-- them a personal code. A code belongs to one customer email, takes a percentage off one order of
-- our own store's stock, can be used once and expires. Redemption happens inside the checkout
-- transaction (row lock on the coupon), so a code can't be spent twice by two tabs at once.
-- Additive only.

CREATE TABLE IF NOT EXISTS coupons (
  code              text PRIMARY KEY,
  customer_email    text NOT NULL,
  percent_off       integer NOT NULL CHECK (percent_off BETWEEN 1 AND 90),
  max_discount_paise integer CHECK (max_discount_paise IS NULL OR max_discount_paise > 0),
  reason            text NOT NULL DEFAULT '',
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  redeemed_order_id uuid REFERENCES orders(id),
  redeemed_at       timestamptz
);
CREATE INDEX IF NOT EXISTS coupons_customer ON coupons (lower(customer_email));

ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_paise integer NOT NULL DEFAULT 0 CHECK (discount_paise >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS coupon_code    text REFERENCES coupons(code);
