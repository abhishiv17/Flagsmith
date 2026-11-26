/**
 * S4 (doc/07 §8): OpenSearch Dashboards, already included with our Aiven OpenSearch, set up for the demo.
 * Usage: npm run dashboards:setup   (idempotent: fixed ids, overwrite)
 *
 * Creates, through the Dashboards saved-objects API (same credentials as OPENSEARCH_URL):
 *   index patterns  products (the live alias the indexer writes) · stockhop-activity (clickstream, time = at)
 *   saved searches  Sold out right now · Last units (1–2 left) · Typo search "bluetoth earphones"
 *   visualizations  catalogue metrics, units by city, sold out by city, stock by category × city,
 *                   good-for occasions, orders over time, what shoppers search, sold-out seen
 *   dashboard       "StockHop · live stock and demand"
 * Everything reads the same index the storefront searches, so it moves live during the demo.
 */
import 'dotenv/config';

const u = new URL(process.env.OPENSEARCH_URL ?? '');
if (!u.hostname) throw new Error('OPENSEARCH_URL is not set');
const base = `https://${u.hostname}`;
const headers = {
  authorization: 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64'),
  'content-type': 'application/json',
  'osd-xsrf': 'true',
};
const PRODUCTS = 'stockhop-products';
const ACTIVITY = 'stockhop-activity';

const ref = (indexId: string) => [{ name: 'kibanaSavedObjectMeta.searchSourceJSON.index', type: 'index-pattern', id: indexId }];
const source = (query = '', language = 'kuery') => ({
  searchSourceJSON: JSON.stringify({ query: { query, language }, filter: [], indexRefName: 'kibanaSavedObjectMeta.searchSourceJSON.index' }),
});

type Agg = { id: string; type: string; schema: string; params?: Record<string, unknown> };
const terms = (id: string, field: string, schema = 'segment', size = 10, orderBy = '1') =>
  ({ id, type: 'terms', schema, params: { field, size, order: 'desc', orderBy, otherBucket: false, missingBucket: false } });

const barParams = (yTitle: string, horizontal = false) => ({
  type: horizontal ? 'horizontal_bar' : 'histogram',
  grid: { categoryLines: false },
  categoryAxes: [{ id: 'CategoryAxis-1', type: 'category', position: horizontal ? 'left' : 'bottom', show: true, style: {}, scale: { type: 'linear' }, labels: { show: true, filter: !horizontal, truncate: 100 }, title: {} }],
  valueAxes: [{ id: 'ValueAxis-1', name: 'LeftAxis-1', type: 'value', position: horizontal ? 'bottom' : 'left', show: true, style: {}, scale: { type: 'linear', mode: 'normal' }, labels: { show: true, rotate: 0, filter: false, truncate: 100 }, title: { text: yTitle } }],
  seriesParams: [{ show: true, type: 'histogram', mode: 'stacked', data: { label: yTitle, id: '1' }, valueAxis: 'ValueAxis-1', drawLinesBetweenPoints: true, lineWidth: 2, showCircles: true }],
  addTooltip: true, addLegend: true, legendPosition: 'right', times: [], addTimeMarker: false, labels: { show: true },
  thresholdLine: { show: false, value: 10, width: 1, style: 'full', color: '#E7664C' },
});
const tableParams = { perPage: 10, showPartialRows: false, showMetricsAtAllLevels: false, sort: { columnIndex: null, direction: null }, showTotal: true, totalFunc: 'sum', percentageCol: '' };
const metricParams = {
  addTooltip: true, addLegend: false, type: 'metric',
  metric: { percentageMode: false, useRanges: false, colorSchema: 'Green to Red', metricColorMode: 'None', colorsRange: [{ from: 0, to: 10000 }], labels: { show: true }, invertColors: false, style: { bgFill: '#000', bgColor: false, labelColor: false, subText: '', fontSize: 48 } },
};

function vis(id: string, title: string, type: string, params: object, aggs: Agg[], index: string, query = '', description = '') {
  return {
    type: 'visualization', id,
    attributes: {
      title, description, version: 1, uiStateJSON: '{}',
      visState: JSON.stringify({ title, type, params, aggs: aggs.map((a) => ({ enabled: true, params: {}, ...a })) }),
      kibanaSavedObjectMeta: source(query),
    },
    references: ref(index),
  };
}

function search(id: string, title: string, query: string, columns: string[], language = 'kuery', sort: [string, string][] = []) {
  return {
    type: 'search', id,
    attributes: { title, description: '', hits: 0, columns, sort, version: 1, kibanaSavedObjectMeta: source(query, language) },
    references: ref(PRODUCTS),
  };
}

const objects = [
  { type: 'index-pattern', id: PRODUCTS, attributes: { title: 'products' }, references: [] },
  { type: 'index-pattern', id: ACTIVITY, attributes: { title: 'stockhop-activity', timeFieldName: 'at' }, references: [] },

  search('sh-sold-out', 'StockHop · Sold out right now', 'in_stock:false', ['name', 'city_name', 'category', 'price_paise'], 'kuery', [['name.kw', 'asc']]),
  search('sh-last-units', 'StockHop · Last units (1–2 left)', 'qty >= 1 and qty <= 2', ['name', 'city_name', 'qty', 'category'], 'kuery', [['qty', 'asc']]),
  // Lucene fuzzy (~): the same typo tolerance the storefront uses, shown in Discover.
  search('sh-typo', 'StockHop · Typo search: "bluetoth earphones"', 'bluetoth~1 AND earphones~1', ['name', 'city_name', 'qty', 'tags'], 'lucene'),

  vis('sh-v-glance', 'StockHop · Catalogue at a glance', 'metric', metricParams, [
    { id: '1', type: 'cardinality', schema: 'metric', params: { field: 'product_id', customLabel: 'Products' } },
    { id: '2', type: 'sum', schema: 'metric', params: { field: 'qty', customLabel: 'Units on shelves (all cities)' } },
  ], PRODUCTS),
  vis('sh-v-soldout-count', 'StockHop · Sold out (product × city)', 'metric', metricParams, [
    { id: '1', type: 'count', schema: 'metric', params: { customLabel: 'Sold out (product × city)' } },
  ], PRODUCTS, 'in_stock:false'),
  vis('sh-v-units-city', 'StockHop · Units on the shelf, by city', 'histogram', barParams('Units'), [
    { id: '1', type: 'sum', schema: 'metric', params: { field: 'qty', customLabel: 'Units' } },
    terms('2', 'city_name'),
  ], PRODUCTS),
  vis('sh-v-soldout-city', 'StockHop · Sold out, by city', 'histogram', barParams('Products sold out'), [
    { id: '1', type: 'count', schema: 'metric', params: { customLabel: 'Products sold out' } },
    terms('2', 'city_name'),
  ], PRODUCTS, 'in_stock:false'),
  vis('sh-v-category-city', 'StockHop · Stock by category and city', 'table', tableParams, [
    { id: '1', type: 'sum', schema: 'metric', params: { field: 'qty', customLabel: 'Units' } },
    { id: '3', type: 'count', schema: 'metric', params: { customLabel: 'Products' } },
    terms('2', 'category', 'bucket', 10),
    terms('4', 'city_name', 'bucket', 3),
  ], PRODUCTS),
  vis('sh-v-uses', 'StockHop · Good for (occasions)', 'horizontal_bar', barParams('Products', true), [
    { id: '1', type: 'cardinality', schema: 'metric', params: { field: 'product_id', customLabel: 'Products' } },
    terms('2', 'uses', 'segment', 13),
  ], PRODUCTS),

  vis('sh-v-orders-time', 'StockHop · Orders over time', 'histogram', barParams('Orders'), [
    { id: '1', type: 'count', schema: 'metric', params: { customLabel: 'Orders' } },
    { id: '2', type: 'date_histogram', schema: 'segment', params: { field: 'at', interval: 'auto', min_doc_count: 1, extended_bounds: {} } },
  ], ACTIVITY, 'type:order_placed'),
  vis('sh-v-searches', 'StockHop · What shoppers search for', 'table', tableParams, [
    { id: '1', type: 'count', schema: 'metric', params: { customLabel: 'Searches' } },
    { id: '3', type: 'min', schema: 'metric', params: { field: 'results', customLabel: 'Fewest results' } },
    terms('2', 'q', 'bucket', 15),
  ], ACTIVITY, 'type:search'),
  vis('sh-v-turned-away', 'StockHop · Shoppers who saw "sold out", by city', 'histogram', barParams('Times'), [
    { id: '1', type: 'count', schema: 'metric', params: { customLabel: 'Times' } },
    terms('2', 'city'),
  ], ACTIVITY, 'type:sold_out_seen'),
];

// Dashboard: 48-column grid.
const panels: [string, number, number, number, number][] = [
  ['sh-v-glance', 0, 0, 24, 10], ['sh-v-soldout-count', 24, 0, 24, 10],
  ['sh-v-units-city', 0, 10, 24, 14], ['sh-v-soldout-city', 24, 10, 24, 14],
  ['sh-v-category-city', 0, 24, 24, 18], ['sh-v-uses', 24, 24, 24, 18],
  ['sh-v-orders-time', 0, 42, 24, 14], ['sh-v-turned-away', 24, 42, 24, 14],
  ['sh-v-searches', 0, 56, 48, 16],
];
objects.push({
  type: 'dashboard', id: 'sh-dashboard',
  attributes: {
    title: 'StockHop · live stock and demand',
    description: 'Reads the same OpenSearch index the storefront searches (kept fresh by Kafka → indexer) plus the shopper clickstream.',
    hits: 0, version: 1, timeRestore: true, timeFrom: 'now-24h', timeTo: 'now',
    refreshInterval: { pause: false, value: 10_000 },
    optionsJSON: JSON.stringify({ hidePanelTitles: false, useMargins: true }),
    panelsJSON: JSON.stringify(panels.map(([, x, y, w, h], i) => ({
      version: '3.6.0', gridData: { x, y, w, h, i: String(i + 1) }, panelIndex: String(i + 1), embeddableConfig: {}, panelRefName: `panel_${i}`,
    }))),
    kibanaSavedObjectMeta: { searchSourceJSON: JSON.stringify({ query: { query: '', language: 'kuery' }, filter: [] }) },
  } as never,
  references: panels.map(([id], i) => ({ name: `panel_${i}`, type: 'visualization', id })) as never,
});

const res = await fetch(`${base}/api/saved_objects/_bulk_create?overwrite=true`, { method: 'POST', headers, body: JSON.stringify(objects) });
const body = (await res.json()) as { saved_objects?: { id: string; type: string; error?: { message: string } }[]; message?: string };
if (!res.ok || !body.saved_objects) throw new Error(`Dashboards API ${res.status}: ${body.message ?? 'unknown error'}`);
const failed = body.saved_objects.filter((o) => o.error);
console.log(`${body.saved_objects.length - failed.length}/${objects.length} saved objects written.`);
for (const f of failed) console.log(`  ✗ ${f.type}:${f.id}: ${f.error!.message}`);

// Make "products" the default index pattern, so Discover opens on it.
await fetch(`${base}/api/opensearch-dashboards/settings`, { method: 'POST', headers, body: JSON.stringify({ changes: { defaultIndex: PRODUCTS } }) });
console.log(`Open: ${base}/app/dashboards#/view/sh-dashboard   (sign in with the service's avnadmin user, from the Aiven console)`.replace(u.hostname, '<opensearch host>'));
if (failed.length) process.exitCode = 1;
