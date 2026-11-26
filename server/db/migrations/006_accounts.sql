-- Optional shopper accounts (doc/17). Passwordless: a 6-digit code proves the shopper owns the email.
-- An account IS a customer (customers.email) whose email has been verified, so "my orders" and the
-- ClickHouse customers dashboard need no new link. Guests keep shopping exactly as before.
-- Additive only.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_sign_in_at   timestamptz;

-- One-time sign-in codes. Only a hash is stored; a code works once, for 10 minutes, 5 tries.
CREATE TABLE IF NOT EXISTS sign_in_codes (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL,              -- lower-cased
  code_hash   text NOT NULL,
  ip_hash     text NOT NULL,              -- for per-network rate limits; never the raw address
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sign_in_codes_email ON sign_in_codes (email, created_at DESC);
CREATE INDEX IF NOT EXISTS sign_in_codes_ip    ON sign_in_codes (ip_hash, created_at DESC);

-- Signed-in sessions. The cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash   text PRIMARY KEY,
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_sessions_customer ON account_sessions (customer_id);
