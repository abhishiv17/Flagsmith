/** Event contracts. See doc/04 §2. The outbox row id doubles as eventId. */

export const EventType = {
  InventoryChanged: 'InventoryChanged',
  OrderPlaced: 'OrderPlaced',
  UserActivity: 'UserActivity',
} as const;
export type EventTypeName = (typeof EventType)[keyof typeof EventType];

/** 'order' also covers a payment hold; 'release' returns a hold whose payment failed or expired. */
export type StockReason = 'order' | 'restock' | 'seed' | 'release';

/** Full product×city search document carried inside InventoryChanged (ADR-4). */
export interface ProductDoc {
  sku: string;
  name: string;
  brand: string;
  category: string;
  description: string;
  tags: string[];
  pricePaise: number;
  imageKey: string;
  cityName: string;
  /** doc/19 (additive; absent in older events) */
  features?: string[];
  uses?: string[];
  about?: string;
  specs?: { group: string; label: string; value: string }[];
  inBox?: string[];
  colour?: string | null;
  connectivity?: string[];
  waterRating?: string | null;
  batteryHours?: number | null;
  weightG?: number | null;
}

export interface InventoryChanged {
  productId: number;
  cityCode: string;
  qty: number;
  delta: number;
  version: number;
  reason: StockReason;
  orderId: string | null;
  doc: ProductDoc;
}

export interface OrderPlaced {
  orderId: string;
  orderNumber: string;
  cityCode: string;
  customer: { name: string; email: string };
  items: { productId: number; name: string; qty: number; unitPricePaise: number }[];
  totalPaise: number;
}

export interface Envelope<T> {
  eventId: number;
  eventType: EventTypeName;
  schemaVersion: 1;
  occurredAt: string;
  payload: T;
}

export const inventoryKey = (productId: number, city: string) => `${productId}:${city}`;
export const docId = (productId: number, city: string) => `${productId}_${city}`;
export const orderNumber = (city: string, orderNo: number | string) => `SH-${city}-${orderNo}`;

/** The OpenSearch document body for a product×city (mapping in doc/04 §3). */
export function toSearchDoc(e: InventoryChanged) {
  return {
    product_id: e.productId,
    sku: e.doc.sku,
    name: e.doc.name,
    brand: e.doc.brand,
    category: e.doc.category,
    description: e.doc.description,
    tags: e.doc.tags.join(' '),
    features: (e.doc.features ?? []).join('. '),
    uses: e.doc.uses ?? [],
    about: e.doc.about ?? '',
    specs_text: (e.doc.specs ?? []).map((s) => `${s.label} ${s.value}`).join('. '),
    in_box: (e.doc.inBox ?? []).join(', '),
    ...(e.doc.colour ? { colour: e.doc.colour.toLowerCase() } : {}),
    connectivity: e.doc.connectivity ?? [],
    ...(e.doc.waterRating ? { water_rating: e.doc.waterRating } : {}),
    ...(e.doc.batteryHours ? { battery_hours: e.doc.batteryHours } : {}),
    ...(e.doc.weightG ? { weight_g: e.doc.weightG } : {}),
    price_paise: e.doc.pricePaise,
    image_key: e.doc.imageKey,
    city: e.cityCode,
    city_name: e.doc.cityName,
    qty: e.qty,
    in_stock: e.qty > 0,
    stock_version: e.version,
    updated_at: new Date().toISOString(),
  };
}
