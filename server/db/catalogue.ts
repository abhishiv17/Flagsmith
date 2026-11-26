/**
 * Deterministic demo catalogue: 30 original products + 36 more (MORE_PRODUCTS, 2 in every city) × 3 cities (doc/04 §4).
 * Slide-3 mockup values MUST stay exact: Everyday Buds ₹1,299 (BLR 1), Pocket Speaker ₹999 (BLR 6),
 * Travel Bottle ₹699 (BLR 8). Brand names are fictional placeholders.
 */
import { DETAILS } from './catalogue-details.js';
import { ABOUT } from './catalogue-about.js';
import { EXTRA_PRODUCTS } from './catalogue-extra.js';

export const CITIES = [
  { code: 'BLR', name: 'Bengaluru' },
  { code: 'MUM', name: 'Mumbai' },
  { code: 'DEL', name: 'Delhi' },
] as const;

export type CityCode = (typeof CITIES)[number]['code'];

export interface SeedProduct {
  sku: string;
  name: string;
  brand: string;
  category: 'audio' | 'wearables' | 'mobile-accessories' | 'home-kitchen' | 'bags-travel'
    | 'gaming' | 'personal-care' | 'smart-home' | 'fitness' | 'camera' | 'computer';
  priceInr: number;
  tags: string[];
  imageKey: string;
  description: string;
  stock: Record<CityCode, number>;
  /** doc/19: feature bullets and "good for" occasions, from catalogue-details.ts */
  features?: string[];
  uses?: string[];
  /** doc/19: who it suits, when you'd use it, what it solves (catalogue-about.ts / catalogue-extra.ts). */
  about?: string;
}

const s = (BLR: number, MUM: number, DEL: number) => ({ BLR, MUM, DEL });

const BASE_PRODUCTS: SeedProduct[] = [
  // --- audio ---
  { sku: 'AUD-001', name: 'Everyday Buds', brand: 'Hop Audio', category: 'audio', priceInr: 1299, imageKey: 'buds',
    tags: ['bluetooth', 'earphones', 'earbuds', 'tws', 'wireless'], stock: s(1, 4, 0),
    description: 'Bluetooth 5.3 true wireless earbuds with 30-hour battery, quick charge and a pocket-sized case.' },
  { sku: 'AUD-002', name: 'Pocket Speaker', brand: 'Hop Audio', category: 'audio', priceInr: 999, imageKey: 'speaker',
    tags: ['bluetooth', 'speaker', 'portable', 'wireless'], stock: s(6, 9, 5),
    description: 'Splash-proof portable Bluetooth speaker with 12 hours of play and a carry loop.' },
  { sku: 'AUD-003', name: 'Studio Over-Ear Headphones', brand: 'Hop Audio', category: 'audio', priceInr: 3499, imageKey: 'headphones',
    tags: ['bluetooth', 'headphones', 'anc', 'wireless', 'over-ear'], stock: s(0, 3, 2),
    description: 'Wireless over-ear headphones with active noise cancellation and soft memory-foam cushions.' },
  { sku: 'AUD-004', name: 'Neckband Pro', brand: 'Hop Audio', category: 'audio', priceInr: 1099, imageKey: 'neckband',
    tags: ['bluetooth', 'earphones', 'neckband', 'wireless'], stock: s(12, 8, 10),
    description: 'Bluetooth neckband earphones with magnetic buds, deep bass and 25-hour battery.' },
  { sku: 'AUD-005', name: 'Bass Cube Speaker', brand: 'Hop Audio', category: 'audio', priceInr: 2199, imageKey: 'speaker',
    tags: ['bluetooth', 'speaker', 'party', 'bass'], stock: s(4, 0, 6),
    description: 'Room-filling Bluetooth party speaker with punchy bass and RGB light ring.' },
  { sku: 'AUD-006', name: 'Classic Wired Earphones', brand: 'Hop Audio', category: 'audio', priceInr: 399, imageKey: 'wired',
    tags: ['wired', 'earphones', '3.5mm', 'mic'], stock: s(25, 30, 20),
    description: 'Tangle-free wired earphones with in-line mic and 3.5 mm jack.' },
  { sku: 'AUD-007', name: 'Kids Safe Headphones', brand: 'Hop Audio', category: 'audio', priceInr: 1499, imageKey: 'headphones',
    tags: ['bluetooth', 'headphones', 'kids', 'volume-limit', 'wireless'], stock: s(2, 5, 0),
    description: 'Lightweight Bluetooth headphones for kids with an 85 dB volume limit.' },
  { sku: 'AUD-008', name: 'Soundbar Mini', brand: 'Hop Audio', category: 'audio', priceInr: 4999, imageKey: 'soundbar',
    tags: ['soundbar', 'tv', 'speaker', 'bluetooth'], stock: s(3, 2, 4),
    description: 'Compact TV soundbar with Bluetooth, optical input and clear dialogue mode.' },
  // --- wearables ---
  { sku: 'WRB-001', name: 'Pulse Fitness Band', brand: 'Hop Fit', category: 'wearables', priceInr: 1799, imageKey: 'band',
    tags: ['fitness', 'band', 'tracker', 'heart-rate'], stock: s(9, 7, 11),
    description: 'Slim fitness band with heart-rate, sleep and step tracking, 14-day battery.' },
  { sku: 'WRB-002', name: 'Orbit Smartwatch', brand: 'Hop Fit', category: 'wearables', priceInr: 3999, imageKey: 'watch',
    tags: ['smartwatch', 'watch', 'bluetooth', 'calling'], stock: s(5, 6, 3),
    description: 'AMOLED smartwatch with Bluetooth calling, SpO2 and 100+ sport modes.' },
  { sku: 'WRB-003', name: 'Step Clip Tracker', brand: 'Hop Fit', category: 'wearables', priceInr: 699, imageKey: 'clip',
    tags: ['pedometer', 'tracker', 'steps'], stock: s(14, 0, 8),
    description: 'Clip-on step tracker with a year-long coin-cell battery.' },
  { sku: 'WRB-004', name: 'Halo Smart Ring', brand: 'Hop Fit', category: 'wearables', priceInr: 4499, imageKey: 'ring',
    tags: ['smart', 'ring', 'sleep', 'tracker'], stock: s(1, 2, 2),
    description: 'Titanium smart ring that tracks sleep, readiness and heart rate.' },
  // --- mobile accessories ---
  { sku: 'MOB-001', name: '20W Fast Charger', brand: 'Hop Power', category: 'mobile-accessories', priceInr: 799, imageKey: 'charger',
    tags: ['charger', 'usb-c', 'fast', 'adapter'], stock: s(20, 18, 22),
    description: '20 W USB-C power delivery wall charger for phones and earbuds.' },
  { sku: 'MOB-002', name: 'Braided USB-C Cable', brand: 'Hop Power', category: 'mobile-accessories', priceInr: 349, imageKey: 'cable',
    tags: ['cable', 'usb-c', 'braided'], stock: s(40, 35, 30),
    description: '1.5 m nylon-braided USB-C to USB-C cable rated for 60 W.' },
  { sku: 'MOB-003', name: '10000mAh Power Bank', brand: 'Hop Power', category: 'mobile-accessories', priceInr: 1199, imageKey: 'powerbank',
    tags: ['power', 'bank', 'powerbank', 'portable', 'charger'], stock: s(7, 0, 9),
    description: 'Pocket 10000 mAh power bank with dual output and 20 W fast charging.' },
  { sku: 'MOB-004', name: 'MagGrip Phone Stand', brand: 'Hop Power', category: 'mobile-accessories', priceInr: 299, imageKey: 'stand',
    tags: ['phone', 'stand', 'holder'], stock: s(15, 12, 10),
    description: 'Foldable aluminium phone stand for desks and video calls.' },
  { sku: 'MOB-005', name: 'Car Charger Duo', brand: 'Hop Power', category: 'mobile-accessories', priceInr: 549, imageKey: 'charger',
    tags: ['car', 'charger', 'usb', 'dual'], stock: s(6, 8, 0),
    description: 'Dual-port car charger with USB-C and USB-A outputs.' },
  { sku: 'MOB-006', name: 'Wireless Charging Pad', brand: 'Hop Power', category: 'mobile-accessories', priceInr: 999, imageKey: 'pad',
    tags: ['wireless', 'charger', 'qi', 'pad'], stock: s(5, 4, 6),
    description: '15 W Qi wireless charging pad with a non-slip top.' },
  // --- home & kitchen ---
  { sku: 'HOM-001', name: 'Travel Bottle', brand: 'Hop Home', category: 'home-kitchen', priceInr: 699, imageKey: 'bottle',
    tags: ['bottle', 'steel', 'insulated', 'flask'], stock: s(8, 10, 7),
    description: '750 ml insulated steel bottle: cold for 24 hours, hot for 12.' },
  { sku: 'HOM-002', name: 'Steel Lunch Box', brand: 'Hop Home', category: 'home-kitchen', priceInr: 549, imageKey: 'lunchbox',
    tags: ['lunch', 'box', 'tiffin', 'steel'], stock: s(11, 9, 12),
    description: 'Three-tier leak-proof steel tiffin with an insulated bag.' },
  { sku: 'HOM-003', name: 'Insulated Coffee Mug', brand: 'Hop Home', category: 'home-kitchen', priceInr: 449, imageKey: 'mug',
    tags: ['mug', 'coffee', 'travel', 'insulated'], stock: s(10, 0, 6),
    description: '350 ml double-wall travel mug with a slide-lock lid.' },
  { sku: 'HOM-004', name: 'LED Desk Lamp', brand: 'Hop Home', category: 'home-kitchen', priceInr: 1299, imageKey: 'lamp',
    tags: ['lamp', 'led', 'desk', 'study'], stock: s(4, 6, 5),
    description: 'Dimmable LED desk lamp with three colour temperatures and a USB port.' },
  { sku: 'HOM-005', name: 'Electric Kettle 1.5L', brand: 'Hop Home', category: 'home-kitchen', priceInr: 1149, imageKey: 'kettle',
    tags: ['kettle', 'electric'], stock: s(6, 5, 0),
    description: '1.5 L stainless-steel electric kettle with auto shut-off.' },
  { sku: 'HOM-006', name: 'USB Mini Fan', brand: 'Hop Home', category: 'home-kitchen', priceInr: 399, imageKey: 'fan',
    tags: ['fan', 'usb', 'portable'], stock: s(18, 15, 20),
    description: 'Quiet three-speed USB desk fan with a tilting head.' },
  // --- bags & travel ---
  { sku: 'BAG-001', name: 'Commuter Backpack', brand: 'Hop Travel', category: 'bags-travel', priceInr: 1899, imageKey: 'backpack',
    tags: ['backpack', 'laptop', 'bag', 'office'], stock: s(7, 9, 8),
    description: 'Water-resistant 25 L backpack with a padded 15.6-inch laptop sleeve.' },
  { sku: 'BAG-002', name: '14" Laptop Sleeve', brand: 'Hop Travel', category: 'bags-travel', priceInr: 699, imageKey: 'sleeve',
    tags: ['laptop', 'sleeve', 'bag'], stock: s(12, 10, 0),
    description: 'Slim padded sleeve for 13–14-inch laptops with a front pocket.' },
  { sku: 'BAG-003', name: 'Travel Pouch Set', brand: 'Hop Travel', category: 'bags-travel', priceInr: 499, imageKey: 'pouch',
    tags: ['pouch', 'organiser', 'travel'], stock: s(9, 11, 10),
    description: 'Set of three packing pouches for cables, toiletries and clothes.' },
  { sku: 'BAG-004', name: 'Weekender Duffel', brand: 'Hop Travel', category: 'bags-travel', priceInr: 2299, imageKey: 'duffel',
    tags: ['duffel', 'bag', 'travel', 'gym'], stock: s(0, 4, 3),
    description: '40 L weekender duffel with a shoe compartment and shoulder strap.' },
  { sku: 'BAG-005', name: 'Compact Umbrella', brand: 'Hop Travel', category: 'bags-travel', priceInr: 399, imageKey: 'umbrella',
    tags: ['umbrella', 'rain', 'compact'], stock: s(22, 30, 15),
    description: 'Auto open/close compact umbrella that fits in a backpack pocket.' },
  { sku: 'BAG-006', name: 'Memory Foam Neck Pillow', brand: 'Hop Travel', category: 'bags-travel', priceInr: 449, imageKey: 'pillow',
    tags: ['neck', 'pillow', 'travel'], stock: s(8, 6, 7),
    description: 'Memory-foam travel neck pillow with a washable cover.' },
];

/**
 * 36 more products, 2 in stock in EVERY city, so the "someone else got it" flow can be shown on
 * many items. Added to a live database with `npm run products:more` (no wipe). Each reuses the
 * photo of its kind (imageKey); swap in its own photo by SKU in web/src/productPhotos.ts.
 */
const two = s(2, 2, 2);
const m = (
  sku: string, name: string, brand: string, category: SeedProduct['category'], priceInr: number,
  imageKey: string, tags: string[], description: string,
): SeedProduct => ({ sku, name, brand, category, priceInr, imageKey, tags, description, stock: two });

export const MORE_PRODUCTS: SeedProduct[] = [
  // --- audio ---
  m('AUD-009', 'Sport Buds', 'Pulse Audio', 'audio', 1599, 'buds', ['bluetooth', 'earbuds', 'tws', 'sport', 'sweatproof'],
    'Sweat-resistant true wireless earbuds with ear hooks that stay put on a run.'),
  m('AUD-010', 'Studio Buds ANC', 'Lumen Sound', 'audio', 2499, 'buds', ['bluetooth', 'earbuds', 'tws', 'anc', 'wireless'],
    'True wireless earbuds with active noise cancellation and a transparency mode.'),
  m('AUD-011', 'Kids Mini Buds', 'Pulse Audio', 'audio', 899, 'buds', ['bluetooth', 'earbuds', 'kids', 'volume-limited'],
    'Small-fit earbuds with an 85 dB volume limit for young listeners.'),
  m('AUD-012', 'Party Box Speaker', 'Lumen Sound', 'audio', 3999, 'speaker', ['bluetooth', 'speaker', 'party', 'lights'],
    'Loud portable party speaker with light ring and 16 hours of play.'),
  m('AUD-013', 'Shower Speaker', 'Pulse Audio', 'audio', 699, 'speaker', ['bluetooth', 'speaker', 'waterproof', 'shower'],
    'IPX7 waterproof suction-cup speaker for the shower or the pool.'),
  m('AUD-014', 'Travel ANC Headphones', 'Lumen Sound', 'audio', 4799, 'headphones', ['bluetooth', 'headphones', 'anc', 'foldable', 'travel'],
    'Foldable noise-cancelling headphones with a 40-hour battery and hard case.'),
  m('AUD-015', 'Sport Neckband', 'Pulse Audio', 'audio', 999, 'neckband', ['bluetooth', 'neckband', 'sport', 'magnetic'],
    'Lightweight neckband with magnetic buds and 20-hour battery.'),
  m('AUD-016', 'Gaming Earphones', 'Lumen Sound', 'audio', 599, 'wired', ['wired', 'earphones', 'gaming', 'mic'],
    'Wired in-ear gaming earphones with a boom-free inline mic and 3.5 mm jack.'),
  // --- wearables ---
  m('WRB-005', 'Pulse Band Lite', 'Kinetic', 'wearables', 1299, 'band', ['fitness', 'band', 'heart-rate', 'sleep'],
    'Slim fitness band with heart-rate, sleep tracking and 14-day battery.'),
  m('WRB-006', 'Pulse Band Pro', 'Kinetic', 'wearables', 2499, 'band', ['fitness', 'band', 'spo2', 'gps', 'amoled'],
    'AMOLED fitness band with SpO2, connected GPS and 100+ workout modes.'),
  m('WRB-007', 'Orbit Watch Active', 'Kinetic', 'wearables', 2999, 'watch', ['smartwatch', 'calling', 'fitness'],
    'Smartwatch with Bluetooth calling, 1.8-inch display and fitness tracking.'),
  m('WRB-008', 'Orbit Watch Pro', 'Kinetic', 'wearables', 5999, 'watch', ['smartwatch', 'amoled', 'gps', 'metal'],
    'Metal-frame AMOLED smartwatch with built-in GPS and a week of battery.'),
  m('WRB-009', 'Kids GPS Watch', 'Kinetic', 'wearables', 3499, 'watch', ['smartwatch', 'kids', 'gps', 'sos'],
    'Kids smartwatch with live location, SOS button and safe-zone alerts.'),
  m('WRB-010', 'Halo Ring Sleep', 'Kinetic', 'wearables', 3999, 'ring', ['smart-ring', 'sleep', 'titanium'],
    'Titanium smart ring that tracks sleep, readiness and resting heart rate.'),
  // --- mobile accessories ---
  m('MOB-007', '33W Dual-Port Charger', 'Volt Works', 'mobile-accessories', 1099, 'charger', ['charger', 'fast-charging', 'usb-c', 'dual'],
    'Compact 33 W wall charger with USB-C and USB-A ports.'),
  m('MOB-008', '65W GaN Charger', 'Volt Works', 'mobile-accessories', 2299, 'charger', ['charger', 'gan', 'laptop', 'usb-c'],
    'Pocket-size 65 W GaN charger that powers a laptop and phone together.'),
  m('MOB-009', 'Lightning Cable 2m', 'Volt Works', 'mobile-accessories', 449, 'cable', ['cable', 'lightning', 'braided'],
    'Braided 2 m Lightning cable rated for 10,000 bends.'),
  m('MOB-010', '3-in-1 Charging Cable', 'Volt Works', 'mobile-accessories', 499, 'cable', ['cable', 'usb-c', 'micro-usb', 'lightning'],
    'One cable with USB-C, Lightning and Micro-USB tips for every device at home.'),
  m('MOB-011', '20000mAh Power Bank', 'Volt Works', 'mobile-accessories', 1899, 'powerbank', ['powerbank', '20000mah', 'fast-charging'],
    'High-capacity 20,000 mAh power bank with 22.5 W fast charging and a display.'),
  m('MOB-012', 'Slim Magnetic Power Bank', 'Volt Works', 'mobile-accessories', 1599, 'powerbank', ['powerbank', 'magnetic', 'wireless'],
    '5,000 mAh magnetic power bank that snaps to the back of your phone.'),
  m('MOB-013', 'Desk Tablet Stand', 'Volt Works', 'mobile-accessories', 599, 'stand', ['stand', 'tablet', 'adjustable', 'aluminium'],
    'Adjustable aluminium stand for phones and tablets up to 13 inches.'),
  m('MOB-014', '3-in-1 Wireless Charger', 'Volt Works', 'mobile-accessories', 2499, 'pad', ['wireless', 'charger', 'charging stand', '3-in-1'],
    'Charges a phone, watch and earbuds at once on one tidy stand.'),
  // --- home & kitchen ---
  m('HOM-007', 'Kids Sipper Bottle', 'Nest and Co', 'home-kitchen', 499, 'bottle', ['bottle', 'kids', 'sipper', 'bpa-free'],
    'Leak-proof 500 ml sipper bottle with a soft straw and carry handle.'),
  m('HOM-008', 'Insulated Steel Bottle 1L', 'Nest and Co', 'home-kitchen', 899, 'bottle', ['bottle', 'insulated', 'steel', 'hot-cold'],
    'Double-wall steel bottle that keeps drinks cold for 24 h or hot for 12 h.'),
  m('HOM-009', '3-Tier Tiffin Box', 'Nest and Co', 'home-kitchen', 749, 'lunchbox', ['lunchbox', 'tiffin', 'steel'],
    'Classic three-tier stainless steel tiffin with a leak-proof lid.'),
  m('HOM-010', 'Ceramic Coffee Mug Set', 'Nest and Co', 'home-kitchen', 599, 'mug', ['mug', 'ceramic', 'set', 'coffee'],
    'Set of two 350 ml ceramic mugs, microwave and dishwasher safe.'),
  m('HOM-011', 'Rechargeable Reading Lamp', 'Nest and Co', 'home-kitchen', 999, 'lamp', ['lamp', 'led', 'rechargeable', 'reading'],
    'Cordless LED reading lamp with three colour temperatures and a dimmer.'),
  m('HOM-012', 'Glass Electric Kettle', 'Nest and Co', 'home-kitchen', 1399, 'kettle', ['kettle', 'glass', 'electric', 'auto-off'],
    '1.7 L glass kettle with a blue glow, auto shut-off and boil-dry protection.'),
  m('HOM-013', 'Clip-on Desk Fan', 'Nest and Co', 'home-kitchen', 549, 'fan', ['fan', 'usb', 'clip', 'rechargeable'],
    'Rechargeable clip-on fan with three speeds for desks, prams and bunk beds.'),
  // --- bags & travel ---
  m('BAG-007', 'Anti-theft Backpack', 'Trail Line', 'bags-travel', 2199, 'backpack', ['backpack', 'anti-theft', 'laptop', 'usb'],
    'Anti-theft laptop backpack with hidden zips and a USB charging port.'),
  m('BAG-008', 'Rolltop Daypack', 'Trail Line', 'bags-travel', 1699, 'backpack', ['backpack', 'waterproof', 'rolltop', 'commute'],
    'Waterproof rolltop daypack for monsoon commutes.'),
  m('BAG-009', '16" Laptop Sleeve', 'Trail Line', 'bags-travel', 849, 'sleeve', ['laptop', 'sleeve', 'bag', '16-inch'],
    'Padded sleeve for 15–16-inch laptops with a charger pocket.'),
  m('BAG-010', 'Toiletry Kit', 'Trail Line', 'bags-travel', 599, 'pouch', ['pouch', 'toiletry', 'hanging', 'travel'],
    'Hanging toiletry kit with a hook and water-resistant lining.'),
  m('BAG-011', 'Cabin Duffel 30L', 'Trail Line', 'bags-travel', 1899, 'duffel', ['duffel', 'cabin', 'bag', 'travel'],
    '30 L cabin-size duffel that fits under a flight seat.'),
  m('BAG-012', 'Windproof Umbrella', 'Trail Line', 'bags-travel', 649, 'umbrella', ['umbrella', 'windproof', 'rain'],
    'Double-canopy windproof umbrella with auto open and close.'),
  m('BAG-013', 'Inflatable Neck Pillow', 'Trail Line', 'bags-travel', 349, 'pillow', ['neck', 'pillow', 'inflatable', 'travel'],
    'Packs flat; inflates in three breaths. Soft velour cover.'),

  // --- 24 more (doc/19): everyday needs people actually search for ---
  m('AUD-017', 'Open-Ear Runner', 'Pulse Audio', 'audio', 2799, 'neckband', ['bluetooth', 'open-ear', 'bone conduction', 'running', 'sport'],
    'Open-ear sport headphones that leave your ears free to hear traffic while you run or cycle.'),
  m('AUD-018', 'Sleep Buds', 'Lumen Sound', 'audio', 1999, 'buds', ['bluetooth', 'earbuds', 'sleep', 'side sleeper', 'white noise'],
    'Tiny, soft earbuds made for side sleepers, with built-in white noise and a sleep timer.'),
  m('AUD-019', 'Karaoke Mic Speaker', 'Pulse Audio', 'audio', 1299, 'speaker', ['bluetooth', 'microphone', 'karaoke', 'party', 'kids'],
    'Wireless karaoke microphone with a built-in speaker, echo effect and LED lights.'),
  m('AUD-020', 'Desk Speaker Pair', 'Lumen Sound', 'audio', 2299, 'speaker', ['speakers', 'desk', 'usb', 'computer', 'wired'],
    'Compact USB-powered stereo speakers for a laptop or desktop, with a volume knob up front.'),
  m('WRB-011', 'Swim Band', 'Kinetic', 'wearables', 1999, 'band', ['fitness', 'band', 'swim', '5atm', 'waterproof'],
    '5 ATM waterproof fitness band that counts laps and strokes in the pool.'),
  m('WRB-012', 'Care Watch SOS', 'Kinetic', 'wearables', 3299, 'watch', ['smartwatch', 'senior', 'sos', 'fall detection', 'parents'],
    'Big-display watch for parents and grandparents, with fall detection and one-press SOS calls.'),
  m('WRB-013', 'Kids Step Buddy', 'Kinetic', 'wearables', 599, 'clip', ['tracker', 'kids', 'steps', 'clip'],
    'Clip-on step counter for kids with a friendly display and daily step goals.'),
  m('MOB-015', 'Bike Phone Mount', 'Volt Works', 'mobile-accessories', 699, 'stand', ['mount', 'bike', 'scooter', 'navigation', 'holder'],
    'Shock-proof phone mount for bike and scooter handlebars, one-hand release.'),
  m('MOB-016', 'Waterproof Phone Pouch', 'Volt Works', 'mobile-accessories', 299, 'pouch', ['waterproof', 'pouch', 'phone', 'rain', 'beach'],
    'IPX8 phone pouch with a lanyard: touchscreen works through it, rain or pool.'),
  m('MOB-017', 'Solar Power Bank', 'Volt Works', 'mobile-accessories', 1699, 'powerbank', ['powerbank', 'solar', 'outdoor', 'torch', '10000mah'],
    'Rugged 10,000 mAh power bank with a solar panel and a built-in torch.'),
  m('MOB-018', 'Car Vent Phone Holder', 'Volt Works', 'mobile-accessories', 449, 'stand', ['car', 'holder', 'mount', 'magnetic', 'navigation'],
    'Magnetic car vent holder that keeps maps in view and lets go with one hand.'),
  m('MOB-019', 'USB-C Hub 6-in-1', 'Volt Works', 'mobile-accessories', 1999, 'cable', ['usb-c', 'hub', 'hdmi', 'laptop', 'adapter'],
    'Adds HDMI, two USB-A, SD, microSD and USB-C charging to a thin laptop.'),
  m('HOM-014', 'Vacuum Flask 750ml', 'Nest and Co', 'home-kitchen', 799, 'bottle', ['flask', 'insulated', 'tea', 'coffee', 'hot'],
    'Keeps tea or coffee hot for 12 hours; the lid doubles as a cup.'),
  m('HOM-015', 'Electric Lunch Box', 'Nest and Co', 'home-kitchen', 1499, 'lunchbox', ['lunchbox', 'electric', 'heated', 'office'],
    'Plug-in lunch box that warms home-cooked food at your desk in 30 minutes.'),
  m('HOM-016', 'Smart LED Bulb', 'Nest and Co', 'home-kitchen', 649, 'lamp', ['bulb', 'smart', 'wifi', 'colour', 'app'],
    'Wi-Fi colour bulb you can dim, schedule and control from your phone or voice assistant.'),
  m('HOM-017', 'Foldable Travel Kettle', 'Nest and Co', 'home-kitchen', 1299, 'kettle', ['kettle', 'travel', 'foldable', 'silicone', 'dual voltage'],
    'Silicone kettle that folds flat for a suitcase; dual voltage for trips abroad.'),
  m('HOM-018', 'Tea Infuser Tumbler', 'Nest and Co', 'home-kitchen', 549, 'mug', ['tumbler', 'tea', 'infuser', 'insulated', 'leak-proof'],
    'Leak-proof insulated tumbler with a removable tea strainer for loose leaf on the go.'),
  m('HOM-019', 'Rechargeable Table Fan', 'Nest and Co', 'home-kitchen', 1199, 'fan', ['fan', 'rechargeable', 'power cut', 'table', 'quiet'],
    'Quiet table fan that runs 8 hours on battery through a power cut.'),
  m('BAG-014', 'Backpack Rain Cover', 'Trail Line', 'bags-travel', 249, 'backpack', ['rain cover', 'waterproof', 'backpack', 'monsoon'],
    'Stretch-fit waterproof cover for backpacks up to 35 L, with a reflective strip.'),
  m('BAG-015', 'Kids School Bag', 'Trail Line', 'bags-travel', 999, 'backpack', ['school bag', 'kids', 'backpack', 'lightweight'],
    'Lightweight school bag with padded straps, a bottle pocket and reflective panels.'),
  m('BAG-016', 'Gym Duffel', 'Trail Line', 'bags-travel', 1199, 'duffel', ['gym', 'duffel', 'shoe compartment', 'sport'],
    'Gym bag with a vented shoe compartment and a wet pocket for towels.'),
  m('BAG-017', 'Passport Organiser', 'Trail Line', 'bags-travel', 449, 'pouch', ['passport', 'travel', 'organiser', 'rfid'],
    'RFID-blocking organiser for passports, cards, boarding passes and a pen.'),
  m('BAG-018', 'Reverse-Fold Umbrella', 'Trail Line', 'bags-travel', 799, 'umbrella', ['umbrella', 'reverse', 'car', 'monsoon', 'windproof'],
    'Closes inside out so the wet side stays in; easy in and out of a car.'),
  m('BAG-019', 'Sleep Kit (Mask + Earplugs)', 'Trail Line', 'bags-travel', 299, 'pillow', ['eye mask', 'earplugs', 'sleep', 'travel', 'flight'],
    'Contoured eye mask and reusable earplugs in a pouch, for flights and night trains.'),
  // --- 120 more across 11 departments (doc/19), with their own details: catalogue-extra.ts ---
  ...EXTRA_PRODUCTS,
];

const withDetails = (p: SeedProduct): SeedProduct => ({
  ...p,
  features: DETAILS[p.sku]?.features ?? p.features ?? [],
  uses: DETAILS[p.sku]?.uses ?? p.uses ?? [],
  about: ABOUT[p.sku] ?? p.about ?? '',
});
export const PRODUCTS: SeedProduct[] = [...BASE_PRODUCTS, ...MORE_PRODUCTS].map(withDetails);
