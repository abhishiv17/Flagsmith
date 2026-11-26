-- "About this item" (doc/19): who a product suits, when you'd use it, what it solves. Shown on the
-- product page and searched by meaning (server/lib/catalog-index.ts). Additive only.
ALTER TABLE products ADD COLUMN IF NOT EXISTS about text NOT NULL DEFAULT '';
