-- "Notify me when it's back" (doc/17): a signed-in shopper asks to be told when a product is back
-- in stock in their city. The notifier (Kafka consumer of inventory.changed) marks waiting alerts as
-- notified when that product's stock in that city goes above 0. Email is simulated, like order
-- confirmations: the alert row + a log line, shown on the account page. Additive only.

CREATE TABLE IF NOT EXISTS back_in_stock_alerts (
  id                bigserial PRIMARY KEY,
  customer_id       uuid    NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id        integer NOT NULL REFERENCES products(id),
  city_code         text    NOT NULL REFERENCES cities(code),
  created_at        timestamptz NOT NULL DEFAULT now(),
  notified_at       timestamptz,
  notified_event_id bigint,
  notified_qty      integer
);
-- One open alert per shopper, product and city.
CREATE UNIQUE INDEX IF NOT EXISTS back_in_stock_one_open
  ON back_in_stock_alerts (customer_id, product_id, city_code) WHERE notified_at IS NULL;
-- What the notifier looks up on every stock change.
CREATE INDEX IF NOT EXISTS back_in_stock_waiting
  ON back_in_stock_alerts (product_id, city_code) WHERE notified_at IS NULL;
