-- Product details for need-based search (doc/19): feature bullets and "good for" occasions.
-- Carried in InventoryChanged events into OpenSearch. Additive only.
ALTER TABLE products ADD COLUMN IF NOT EXISTS features text[] NOT NULL DEFAULT '{}';
ALTER TABLE products ADD COLUMN IF NOT EXISTS uses     text[] NOT NULL DEFAULT '{}';
