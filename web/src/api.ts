/** Typed client for the StockHop API (doc/05). */

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}, signal?: AbortSignal, attempt = 0): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      signal,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...init.headers },
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'Can’t reach StockHop. Check your connection.');
  }
  const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string; details?: unknown } } | null;
  // 503 BUSY means the server never reached the database (all connections in use), so retrying is
  // safe even for POSTs; checkout is idempotent anyway. Two retries with Retry-After + jitter.
  if (res.status === 503 && body?.error?.code === 'BUSY' && attempt < 2) {
    const wait = (Number(res.headers.get('retry-after')) || 1) * 1000 * (attempt + 1) + Math.random() * 400;
    await new Promise((r) => setTimeout(r, wait));
    return api<T>(path, init, signal, attempt + 1);
  }
  if (!res.ok) {
    // Lazy import keeps track.ts out of this module's load path; analytics never block shopping.
    const code = body?.error?.code ?? 'INTERNAL';
    if (!path.startsWith('/track') && !path.startsWith('/ops') && !path.startsWith('/retailer')) {
      // For sold-out moments, record which product and why ("Missed demand" on /ops).
      const d = body?.error?.details as { productId?: number; reason?: string; items?: { productId: number }[] } | undefined;
      const productId = d?.productId ?? d?.items?.[0]?.productId;
      void import('./track').then(({ track }) =>
        code === 'OUT_OF_STOCK'
          ? track('sold_out_seen', { code, productId, label: d?.reason ?? (d?.items ? 'checkout' : undefined) })
          : track('api_error', { code }),
      );
    }
    throw new ApiError(res.status, body?.error?.code ?? 'INTERNAL', body?.error?.message ?? 'Something went wrong', body?.error?.details);
  }
  return body as T;
}

export const post = <T>(path: string, data: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const patch = <T>(path: string, data: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(data) });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

export type CityCode = 'BLR' | 'MUM' | 'DEL';
export const CITIES: { code: CityCode; name: string }[] = [
  { code: 'BLR', name: 'Bengaluru' },
  { code: 'MUM', name: 'Mumbai' },
  { code: 'DEL', name: 'Delhi' },
];
export const cityName = (code: string) => CITIES.find((c) => c.code === code)?.name ?? code;

export interface Nearby { city: string; cityName: string; qty: number }

export interface SearchItem {
  productId: number; sku: string; name: string; brand: string; category: string;
  pricePaise: number; imageKey: string; city: string; qty: number; inStock: boolean;
  stockVersion: number; nearby: Nearby | null;
  /** doc/19: why this matched (occasions + a highlighted snippet, [[term]] marks a hit). */
  why?: string | null;
  /** Partner shops in this city that also have it (search results only). */
  partners?: { shops: number; minPricePaise: number; topShop: string } | null;
}

export type SortKey = 'relevance' | 'price_asc' | 'price_desc' | 'stock' | 'name';
export const SORTS: { key: SortKey; label: string }[] = [
  { key: 'relevance', label: 'Best match' },
  { key: 'price_asc', label: 'Price: low to high' },
  { key: 'price_desc', label: 'Price: high to low' },
  { key: 'stock', label: 'Most in stock' },
  { key: 'name', label: 'Name: A to Z' },
];

/** A partner shop with live counts (GET /shops, /shops/:slug, search). */
export interface ShopSummary {
  id: number; slug: string; name: string; city: CityCode; cityName: string; rating: number; deliveryNote: string;
  products: number; inStock: number; lastUnits: number; minPricePaise: number | null;
}

/** One product on a partner shop's shelf: its price there, ours, and its live stock. */
export interface ShopItem {
  productId: number; sku: string; name: string; brand: string; category: string; imageKey: string;
  pricePaise: number; ourPricePaise: number; qty: number; inStock: boolean; updatedAt: string;
}

export interface ShopPage {
  shop: ShopSummary;
  items: ShopItem[];
  categories: { key: string; count: number }[];
  matchedBy: 'opensearch' | 'postgres' | null;
  tookMs: number;
}

/** GET /suggest: the dropdown under every search box. */
export interface Suggestions {
  q: string;
  completions: { text: string; count: number }[];
  products: { productId: number; sku: string; name: string; brand: string; category: string; pricePaise: number; imageKey: string; qty: number; inStock: boolean }[];
  categories: { key: string; count: number }[];
  shops: { slug: string; name: string; city: CityCode; cityName: string; inStock: number; products: number }[];
  /** Empty box only: real searches trending in this city this week. */
  trending?: { q: string; visitors: number }[];
  tookMs: number;
}

/** GET /together: frequently bought together (ClickHouse orders), then complements (OpenSearch). */
export interface Together {
  items: (SearchItem & { basis: 'orders' | 'goes-with'; orders?: number })[];
  boughtWeek: number | null;
  tookMs: number;
}

export interface SearchResult {
  tookMs: number;
  total: number;
  items: SearchItem[];
  facets: {
    categories: { key: string; count: number }[];
    priceBands: { key: string; count: number }[];
    uses?: { key: string; label: string; count: number }[];
    colours?: { key: string; count: number }[];
    connectivity?: { key: string; count: number }[];
    water?: { key: string; count: number }[];
    battery?: { key: string; count: number }[];
  };
  /** Nothing matched most of the words, so these are close matches. */
  relaxed?: boolean;
  /** The city searched (a query can name another city: "power bank in mumbai"). */
  city?: string;
  /** Partner shops whose name the query matched, each with the first items on its shelf. */
  shops?: (ShopSummary & { items: ShopItem[] })[];
  /** What the search understood from the sentence, as removable chips. */
  intent?: { understood: { key: string; label: string }[]; text: string; notice?: string } | null;
}

export interface LiveItem {
  productId: number; city: string; qty: number; inStock: boolean; stockVersion: number; nearby: Nearby | null;
}

export interface ProductDetail {
  productId: number; sku: string; name: string; brand: string; category: string; description: string;
  tags: string[]; pricePaise: number; imageKey: string;
  /** doc/19 */
  features?: string[];
  uses?: { key: string; label: string }[];
  /** Who it suits, when you'd use it, what it solves (doc/19). */
  about?: string;
  specs?: { group: string; label: string; value: string }[];
  inBox?: string[];
  warrantyMonths?: number | null;
  attrs?: { colour: string | null; connectivity: string[]; waterRating: string | null; batteryHours: number | null; weightG: number | null };
  stock: { city: string; cityName: string; qty: number; version: number }[];
  /** With ?city=: what this shopper can still add (others' cart claims taken out). */
  forYou?: {
    shelf: number;
    inOtherCarts: number;
    availableToYou: number;
    reason: 'sold_out' | 'being_paid_for' | 'in_someone_cart' | null;
  };
}

export interface Cart {
  cartId: string | null;
  city: string;
  items: {
    productId: number; sku: string; name: string; imageKey: string; qty: number;
    unitPricePaise: number; available: number; shortBy: number;
  }[];
  subtotalPaise: number;
  otherCityCarts: { city: string; itemCount: number }[];
}

export interface Order {
  orderId: string; orderNumber: string; city: string; status: string;
  items: { productId: number; sku: string; name: string; imageKey: string; qty: number; unitPricePaise: number; seller?: string | null }[];
  totalPaise: number; createdAt: string;
  /** Razorpay payment ID once paid (Test Mode); null when payments are off or not yet paid. */
  paymentId?: string | null;
  confirmationSent: boolean; confirmationAt: string | null; confirmationTo: string | null;
}

export interface ShortItem { productId: number; name: string; requested: number; available: number }

/** The same product from a partner retailer in the shopper's city. */
export interface Offer {
  sellerId: number;
  sellerName: string;
  rating: number;
  deliveryNote: string;
  productId: number;
  pricePaise: number;
  qty: number;
}

export interface OpsSummary {
  services: { postgres: 'up' | 'down'; opensearch: 'up' | 'down'; valkey?: 'up' | 'down' | 'off' };
  workers: { name: string; up: boolean; lastSeenMs: number | null }[];
  outbox: { pending: number; lastPublishedId: number } | null;
  consumers: { group: string; topic: string; lag: number; stale: boolean }[];
  index: { docs: number; inSync: number; drift: { key: string; pgQty: number; pgVersion: number; osQty: number | null; osVersion: number | null }[] } | null;
  recentEvents: { id: number; type: string; key: string; summary: string; createdAt: string; publishedAt: string | null }[];
  recentNotifications: { to: string; body: string; at: string }[];
  stockAlerts: { product: string; city: string; qty: number; at: string }[];
  orders: { total: number; lastMinute: number } | null;
}

export const inr = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: paise % 100 ? 2 : 0 })}`;

export const CATEGORY_LABEL: Record<string, string> = {
  audio: 'Audio',
  wearables: 'Wearables',
  'mobile-accessories': 'Mobile accessories',
  'home-kitchen': 'Home & kitchen',
  'bags-travel': 'Bags & travel',
  gaming: 'Gaming',
  'personal-care': 'Personal care',
  'smart-home': 'Smart home',
  fitness: 'Fitness & health',
  camera: 'Camera & creators',
  computer: 'Computer & desk',
};

/** Price presets: keys match the server's price_bands facet. Bounds in paise, inclusive. */
export const PRICE_BANDS: { key: string; label: string; min?: number; max?: number }[] = [
  { key: 'under-500', label: 'Under ₹500', max: 49_999 },
  { key: '500-1500', label: '₹500–1,500', min: 50_000, max: 149_999 },
  { key: '1500-3000', label: '₹1,500–3,000', min: 150_000, max: 299_999 },
  { key: '3000-plus', label: '₹3,000+', min: 300_000 },
];

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Fallback for non-secure contexts (plain-HTTP LAN testing).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** GET /where-to-buy: every place this shopper can still get a product. */
export interface WhereToBuy {
  productId: number;
  name: string;
  ourPricePaise: number;
  city: string;
  cityName: string;
  /** 1. another shop in the shopper's city */
  sameCityPartners: Offer[];
  /** 2. our store in other cities (ours = units free to this shopper) and 3. shops there */
  otherCities: { city: string; cityName: string; ours: number; partners: Offer[] }[];
}

/** Optional shopper account (doc/17): a customer with a verified email. */
export interface Account { id: string; name: string; email: string; phone: string | null }
/** The partner shop an account runs (doc/18), if any. */
export interface RetailerShop { id: number; slug: string; name: string; city: string; cityName: string; rating: number; deliveryNote: string }

export interface MyOrder {
  orderId: string; orderNumber: string; city: string; status: string; totalPaise: number;
  createdAt: string; itemCount: number; firstItem: string | null;
}

/** "Notify me when it's back" (doc/17). */
export interface BackInStockAlert {
  id: number; productId: number; name: string; sku: string; imageKey: string; city: string;
  createdAt: string; notifiedAt: string | null; qtyNow: number;
}
