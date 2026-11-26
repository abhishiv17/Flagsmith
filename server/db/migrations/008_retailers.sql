-- Retailer accounts (doc/18). A partner shop (sellers) gets an owner: the email that signs in with the
-- same passwordless code as shoppers (doc/17) and then sees that shop's own dashboard.
-- Coupons can now belong to a shop: a shop's coupon only works when buying from that shop.
-- Additive only.

ALTER TABLE sellers ADD COLUMN IF NOT EXISTS owner_email text;
CREATE UNIQUE INDEX IF NOT EXISTS sellers_owner_email ON sellers (lower(owner_email)) WHERE owner_email IS NOT NULL;

ALTER TABLE coupons ADD COLUMN IF NOT EXISTS seller_id integer REFERENCES sellers(id);
CREATE INDEX IF NOT EXISTS coupons_seller ON coupons (seller_id, created_at DESC) WHERE seller_id IS NOT NULL;
