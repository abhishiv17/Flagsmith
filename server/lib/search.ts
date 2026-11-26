import { Client } from '@opensearch-project/opensearch';
import { searchConfig } from '../config.js';

let client: Client | undefined;

/** Aiven OpenSearch: credentials are in the service URI; Aiven uses a public CA. */
export function getSearch(): Client {
  if (!client) {
    client = new Client({ node: searchConfig().node, requestTimeout: 5000 });
  }
  return client;
}

export function searchIndex() {
  const { alias, indexName } = searchConfig();
  return { alias, indexName };
}
