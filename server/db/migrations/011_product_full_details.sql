-- Full product details (doc/19), structured like a marketplace product page: About this item,
-- grouped Specifications, What's in the box, Warranty, plus normalised attributes that OpenSearch
-- filters, facets and ranks on. Carried in InventoryChanged events into the index. Additive only.
ALTER TABLE products ADD COLUMN IF NOT EXISTS about            text    NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS specs            jsonb   NOT NULL DEFAULT '[]';
ALTER TABLE products ADD COLUMN IF NOT EXISTS in_box           text[]  NOT NULL DEFAULT '{}';
ALTER TABLE products ADD COLUMN IF NOT EXISTS warranty_months  integer;
ALTER TABLE products ADD COLUMN IF NOT EXISTS colour           text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS connectivity     text[]  NOT NULL DEFAULT '{}';
ALTER TABLE products ADD COLUMN IF NOT EXISTS water_rating     text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS battery_hours    integer;
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_g         integer;
