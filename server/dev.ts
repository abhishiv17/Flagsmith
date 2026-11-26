/** Local API server. On Vercel the same app runs via api/index.ts. */
import { createApp } from './app.js';
import { env } from './config.js';
import { log } from './lib/log.js';
import { syncCatalog } from './lib/catalog-index.js';
import { startShopsIndex } from './lib/shops-index.js';

createApp().listen(env.PORT, () => {
  log.info(`api listening on http://localhost:${env.PORT}`);
  void syncCatalog(); // meaning search (doc/19), in the background
  startShopsIndex(); // partner shops: shop-name search and search inside a shop
});
