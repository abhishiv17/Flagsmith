-- Partner retailers: other shops in the same city that sell some of the same products.
-- When our own shelf is empty (or someone else wins the last unit), shoppers can buy the same item
-- from a partner without leaving StockHop. Additive only.

CREATE TABLE IF NOT EXISTS sellers (
  id            serial PRIMARY KEY,
  slug          text UNIQUE NOT NULL,
  name          text NOT NULL,
  city_code     text NOT NULL REFERENCES cities(code),
  rating        numeric(2,1) NOT NULL CHECK (rating BETWEEN 0 AND 5),
  delivery_note text NOT NULL
);

-- A partner's price and stock for one of our catalogue products. Changed only by conditional
-- UPDATE ... WHERE qty >= n (same race-safety as inventory).
CREATE TABLE IF NOT EXISTS seller_offers (
  seller_id    integer NOT NULL REFERENCES sellers(id),
  product_id   integer NOT NULL REFERENCES products(id),
  price_paise  integer NOT NULL CHECK (price_paise > 0),
  qty          integer NOT NULL CHECK (qty >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seller_id, product_id)
);
CREATE INDEX IF NOT EXISTS seller_offers_product ON seller_offers (product_id) WHERE qty > 0;

-- NULL = sold by StockHop's own store (all existing rows).
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS seller_id integer REFERENCES sellers(id);
