-- Coupon links open a specific product in the customer's city (doc/16): the product they look at most,
-- in the city they order from. The discount still applies to the whole order. Additive only.
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS product_id integer REFERENCES products(id);
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS city_code  text REFERENCES cities(code);
