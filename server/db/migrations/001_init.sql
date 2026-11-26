-- StockHop schema v1. See doc/04-data-model-and-events.md
-- Invariants (doc/03 §3): every inventory change writes an outbox row in the same txn (I-1);
-- only PostgreSQL allocates stock (I-2); qty >= 0 (I-3); version +1 per change (I-4).

CREATE TABLE IF NOT EXISTS cities (
  code  text PRIMARY KEY,
  name  text NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id           serial PRIMARY KEY,
  sku          text UNIQUE NOT NULL,
  name         text NOT NULL,
  brand        text NOT NULL,
  category     text NOT NULL,
  description  text NOT NULL DEFAULT '',
  tags         text[] NOT NULL DEFAULT '{}',
  price_paise  integer NOT NULL CHECK (price_paise > 0),
  image_key    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Stock versions come from ONE global sequence that is never reset (not even by demo:reset).
-- So a replayed old Kafka event always carries a lower version than current state, and
-- OpenSearch external versioning rejects it (I-4, I-5).
CREATE SEQUENCE IF NOT EXISTS inventory_version_seq;

CREATE TABLE IF NOT EXISTS inventory (
  product_id  integer NOT NULL REFERENCES products(id),
  city_code   text    NOT NULL REFERENCES cities(code),
  qty         integer NOT NULL CHECK (qty >= 0),
  version     bigint  NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, city_code)
);

CREATE TABLE IF NOT EXISTS customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  email       text UNIQUE NOT NULL,
  phone       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS carts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  text NOT NULL,
  city_code   text NOT NULL REFERENCES cities(code),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'checked_out')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS carts_one_active ON carts (session_id, city_code) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id     uuid    NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id  integer NOT NULL REFERENCES products(id),
  qty         integer NOT NULL CHECK (qty BETWEEN 1 AND 10),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no         bigserial UNIQUE,
  customer_id      uuid NOT NULL REFERENCES customers(id),
  city_code        text NOT NULL REFERENCES cities(code),
  status           text NOT NULL DEFAULT 'confirmed',
  total_paise      integer NOT NULL,
  idempotency_key  text UNIQUE NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id          uuid    NOT NULL REFERENCES orders(id),
  product_id        integer NOT NULL REFERENCES products(id),
  qty               integer NOT NULL CHECK (qty > 0),
  unit_price_paise  integer NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE IF NOT EXISTS outbox (
  id            bigserial PRIMARY KEY,
  topic         text  NOT NULL,
  msg_key       text  NOT NULL,
  event_type    text  NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

-- Written only by the notifier consumer.
CREATE TABLE IF NOT EXISTS notifications (
  id          bigserial PRIMARY KEY,
  event_id    bigint UNIQUE NOT NULL,
  order_id    uuid NOT NULL REFERENCES orders(id),
  channel     text NOT NULL DEFAULT 'email',
  recipient   text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_alerts (
  id          bigserial PRIMARY KEY,
  event_id    bigint UNIQUE NOT NULL,
  product_id  integer NOT NULL REFERENCES products(id),
  city_code   text NOT NULL REFERENCES cities(code),
  qty         integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Written by the workers' pipeline monitor (consumer lag, heartbeats); read by /api/ops on Vercel,
-- which never connects to Kafka itself.
CREATE TABLE IF NOT EXISTS pipeline_stats (
  key         text PRIMARY KEY,            -- e.g. 'lag:search-indexer:inventory.changed', 'heartbeat:indexer'
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
