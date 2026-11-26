-- Product reviews (Toggle Wars, doc/experiment.md): shown on the product page in the "reviews"
-- version of the product_trust_signal experiment. Additive only.
--
-- author_key is the one-way visitor hash (server/domain/activity.ts), never the raw session or an
-- email: it only lets one browser leave one review per product. Demo reviews have source 'seed'
-- and no author_key (scripts/reviews-seed.ts).
CREATE TABLE IF NOT EXISTS product_reviews (
  id           bigserial PRIMARY KEY,
  product_id   integer     NOT NULL REFERENCES products(id),
  rating       smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body         text        NOT NULL CHECK (char_length(body) BETWEEN 10 AND 500),
  author_name  text        NOT NULL CHECK (char_length(author_name) BETWEEN 1 AND 40),
  city_code    text        REFERENCES cities(code),
  author_key   text,
  source       text        NOT NULL DEFAULT 'shopper' CHECK (source IN ('shopper', 'seed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, author_key)
);

CREATE INDEX IF NOT EXISTS product_reviews_product_recent ON product_reviews (product_id, created_at DESC);
