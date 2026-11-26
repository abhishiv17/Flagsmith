/**
 * Production entry for container hosts (Aiven Runtime): one process serves the built storefront
 * (dist/) and the API. Build first with `npm run build`.
 */
import { join } from 'node:path';
import { createApp } from './app.js';
import { env } from './config.js';
import { log } from './lib/log.js';
import { syncCatalog } from './lib/catalog-index.js';
import { startShopsIndex } from './lib/shops-index.js';

const port = Number(process.env.PORT ?? env.PORT);
createApp({ staticDir: join(process.cwd(), 'dist') }).listen(port, () => {
  log.info(`stockhop web+api listening on :${port}`);
  // Meaning search (doc/19): load the model and embed any product whose text changed, in the
  // background. Until it's done, search answers with keywords only.
  void syncCatalog();
  // Partner shops in OpenSearch: shop-name search and search inside a shop.
  startShopsIndex();
});
