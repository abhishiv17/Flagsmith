/**
 * Product photos (free stock, e.g. Unsplash or Pexels licence).
 *
 * Every product has its own free Unsplash photo (no two share one), loaded from Unsplash's image CDN.
 *
 * TO SWAP ONE
 * - Unsplash: open the photo page, copy the "photo-…" id from its image URL and the page slug,
 *   then use u(id, slug, photographerHandle). Avoid photos with visible brand logos.
 * - Your own file: save web/public/products/<file>.jpg (~1200 px, < 250 KB) and add
 *   { src: '/products/<file>.jpg', credit, sourceUrl }.
 * Register by SKU when two products share an imageKey (both speakers, both headphones, both
 * chargers), otherwise by imageKey. Credits feed the README disclosure (rule 7).
 *
 * Products without an entry keep their SVG illustration, so the app never shows a broken image.
 */

export interface Photo {
  /** Path under web/public, e.g. "/products/buds.jpg", or a full https URL. */
  src: string;
  /** Photographer and site, e.g. "Jane Doe on Unsplash". */
  credit: string;
  /** Link to the photo's page, for the credits list. */
  sourceUrl: string;
  /** Optional crop focus for object-position, e.g. "50% 40%". */
  focus?: string;
}

/**
 * Unsplash photo: served from Unsplash's image CDN (hotlinking is how Unsplash asks to be used),
 * resized on their side. `id` is the "photo-…" part of images.unsplash.com, `slug` the photo page.
 */
const u = (id: string, slug: string, handle: string, crop?: 'left' | 'right' | 'top' | 'bottom' | 'entropy'): Photo => ({
  // Square crop is done by Unsplash; `crop` picks which part of a wide/tall photo to keep.
  src: `https://images.unsplash.com/${id}?auto=format&fit=crop&w=900&h=900&q=72${crop ? `&crop=${crop}` : ''}`,
  credit: `@${handle} on Unsplash`,
  sourceUrl: `https://unsplash.com/photos/${slug}`,
});

/** Wins over PHOTOS_BY_KEY. SKUs are in server/db/catalogue.ts. */
export const PHOTOS_BY_SKU: Record<string, Photo> = {
  'AUD-002': u('photo-1582978571763-2d039e56f0c3', 'white-and-silver-portable-speaker-on-brown-wooden-table-gbG65gRAGx4', 'nicolasjleclercq'),
  'AUD-005': u('photo-1507878566509-a0dbe19677a5', 'selective-focus-photography-of-black-and-gray-portable-speaker-VSYq9nS-fY0', 'jonasjacobsson'),
  'AUD-003': u('photo-1505740420928-5e560c06d30e', 'flatlay-photography-of-wireless-headphones-PDX_a_82obo', 'cdx2'),
  'AUD-007': u('photo-1613040809024-b4ef7ba99bc3', 'pink-and-white-wireless-headphones-Zam8TvEgN5o', 'ervorocks'),
  'MOB-001': u('photo-1586254116951-5263e2cdb44c', 'white-adapter-on-yellow-wall-9QTFMkh-ezM', 'markuswinkler'),
  'MOB-005': u('photo-1788805996763-5a511ed16064', 'smartphone-charging-on-car-seat-A_uFdxYsAMQ', 'silaslundquist'),

  'AUD-014': u('photo-1618366712010-f4ae9c647dcb', 'black-wireless-headphones-on-white-table-lUMj2Zv5HUE', 'ldpeterson11'), // Travel ANC Headphones
  // doc/19: every product has its own photo (no two products share one). Found on Unsplash (free licence),
  // checked by eye for the right item and no visible brand logos.
  'AUD-009': u('photo-1777216794546-35784e0dec81', 'zKotXMXP5_k', 'y2j_x'), // Sport Buds
  'AUD-010': u('photo-1606220588913-b3aacb4d2f46', 'black-and-blue-bluetooth-earbuds-qt9_OfTaaeY', 'theregisti'), // Studio Buds ANC
  'AUD-011': u('photo-1566654108568-958bce3400b8', 'SdBWe3e0_9Q', 'ziontech'), // Kids Mini Buds
  'AUD-018': u('photo-1718174104766-7f90819e29f4', 'a-pair-of-ear-buds-sitting-on-top-of-a-blanket-OzuSVYbTSKU', 'ar7an'), // Sleep Buds
  'AUD-013': u('photo-1547052178-7f2c5a20c332', 'oval-grey-portable-speaker-on-white-surface--WB52caEpmI', 'naive_eye'), // Shower Speaker
  'AUD-019': u('photo-1521424159246-e4a66f267e4b', 'black-and-gray-corded-microphone-hvgd0ygXuQQ', 'designecologist'), // Karaoke Mic Speaker
  'AUD-020': u('photo-1609702847389-b8aec1b0b929', 'black-and-gray-speakers-on-brown-wooden-table-i-FJ4obOoyM', 'sandy_kawadkar'), // Desk Speaker Pair
  'AUD-012': u('photo-1790008881703-c5c91d82ea38', 'child-touching-portable-speaker-controls-sH0WtaJmgTE', 'eusuntvibes'), // Party Box Speaker
  'AUD-015': u('photo-1653919114056-640c16de7838', 'a-pair-of-headphones-sitting-on-top-of-a-table-2esJN3NDL6w', 'spxclicks'), // Sport Neckband
  'AUD-016': u('photo-1742570922875-e5a60e950307', 'white-earbuds-and-their-cable-on-a-pink-surface-8tl8K-2aINQ', 'americanaez225'), // Gaming Earphones
  'AUD-017': u('photo-1758520706103-41d01f815640', 'man-running-with-headphones-in-a-forest-YNYRWyiCAYg', 'silverkblack'), // Open-Ear Runner
  'WRB-005': u('photo-1762331658154-8aa265ca21e5', 'woman-wearing-fitness-tracker-sits-outdoors-ynjqLekPsGw', 'zulfugarkarimov'), // Pulse Band Lite
  'WRB-006': u('photo-1561212942-0d77ee345b35', 'man-looking-at-black-fitness-tracker-NQf59hHbN34', 'fitnish'), // Pulse Band Pro
  'WRB-013': u('photo-1531140035644-4ce1e6e1b85f', 'man-looking-at-activity-tracker-jFzOZTf-9Yk', 'fitnish'), // Kids Step Buddy
  'WRB-011': u('photo-1691439378545-dd6b35ff2f7b', 'a-close-up-of-a-watch-on-a-table-N2SL3YWInWY', 'rodolfobarretoweb'), // Swim Band
  'WRB-007': u('photo-1579586337278-3befd40fd17a', 'smartwatch-with-colorful-app-display-2wFoa040m8g', 'sdaoudi'), // Orbit Watch Active
  'WRB-008': u('photo-1569411032431-07598b0012c2', 'black-smartwatch-with-gray-strap-BGGHiSp2Quw', 'iamdavid_10'), // Orbit Watch Pro
  'WRB-009': u('photo-1764169604706-d19a7cfdf823', 'close-up-of-a-person-wearing-a-smartwatch-CbZhp2P_-lI', 'cranky_bear'), // Kids GPS Watch
  'WRB-012': u('photo-1660844817855-3ecc7ef21f12', 'a-watch-with-a-black-face-FPEBZJLD8Rs', 'pratik19'), // Care Watch SOS
  'WRB-010': u('photo-1589674781759-c21c37956a44', 'silver-diamond-ring-on-white-surface-kuko1hX_kXw', 'sabrinnaringquist'), // Halo Ring Sleep
  'MOB-007': u('photo-1627886107121-b7daaede3974', 'white-charger-adapter-on-brown-wooden-table-WM5dFDWVrm8', 'ahmeyer'), // 33W Dual-Port Charger
  'MOB-008': u('photo-1756043827116-5764e6d23d85', 'k10a3PdimMg', 'zelebb'), // 65W GaN Charger
  'MOB-009': u('photo-1603539444875-76e7684265f6', 'white-usb-cable-on-white-table-115YGe1M28I', 'solenfeyissa'), // Lightning Cable 2m
  'MOB-010': u('photo-1573868388390-2739872961e6', 'black-and-white-usb-data-cables-QM9yzAoX-GQ', 'halacious'), // 3-in-1 Charging Cable
  'MOB-019': u('photo-1760376789478-c1023d2dc007', 'black-usb-hub-with-multiple-ports-and-switches-b1UEh_5dKLY', 'barryalbert24'), // USB-C Hub 6-in-1
  'MOB-011': u('photo-1566554738544-d962991c3fee', 'APdfyW0Aq-E', 'ziontech'), // 20000mAh Power Bank
  'MOB-012': u('photo-1635861321688-b63d28749a82', 'a-person-holding-a-cell-phone-and-a-charger-GVRv0wMErKI', 'reka_says_hi'), // Slim Magnetic Power Bank
  'MOB-017': u('photo-1710014959134-ab832a854549', 'a-solar-panel-attached-to-a-tree-PmdVqDJvioA', 'gyulavari'), // Solar Power Bank
  'MOB-013': u('photo-1780802369931-d6eee63ea4c2', 'modern-grey-tablet-stand-on-a-wooden-desk-sIKWKV8IheY', 'who0ne'), // Desk Tablet Stand
  'MOB-015': u('photo-1761721576781-baaf47945242', 'smartphone-mounted-on-bicycle-handlebars-Pm1II-WS3aI', 'mrvigner'), // Bike Phone Mount
  'MOB-018': u('photo-1764347923709-fc48487f2486', 'smartphone-navigation-app-displaying-a-route-P85dQzlsPlc', 'william_hadley_us'), // Car Vent Phone Holder
  'MOB-014': u('photo-1545235616-db3cd822ad8c', 'smartphone-on-wireless-charging-case-Fo1ZKpX4-f8', 'danielkorpai'), // 3-in-1 Wireless Charger
  'MOB-016': u('photo-1722510825309-8337970e947a', 'a-white-cell-phone-case-sitting-on-top-of-a-bed-wx8hxCtV4fE', 'aashish_chandra'), // Waterproof Phone Pouch
  'HOM-007': u('photo-1591345299642-13726d9c80c1', 'white-and-red-plastic-bottle-b1Z4Um349nI', 'chaurasia'), // Kids Sipper Bottle
  'HOM-008': u('photo-1605714312496-01e90cb509cc', 'white-bottle-on-white-table-Aej5gA11eHQ', 'vanesagiaconi'), // Insulated Steel Bottle 1L
  'HOM-014': u('photo-1613645540553-d98859ffeec5', 'silver-vacuum-flask-on-brown-dried-grass-l4VPAybei94', 'jeffreyfotografie'), // Vacuum Flask 750ml
  'HOM-009': u('photo-1633504785850-018cae02cb47', 'gw4kOJzpF0U', 'rickysinghy'), // 3-Tier Tiffin Box
  'HOM-015': u('photo-1781747835478-a9c3bab5a670', 'a-partitioned-lunchbox-filled-with-rice-chicken-FttWZx9-wCk', 'syamsulhaj'), // Electric Lunch Box
  'HOM-010': u('photo-1590422749897-47036da0b0ff', 'white-ceramic-mug-on-white-table-u_jt9A7FADk', 'dreamcatchlight'), // Ceramic Coffee Mug Set
  'HOM-018': u('photo-1729192293999-ffbdc97cbac9', 'a-pink-tumbler-next-to-some-sliced-oranges-OPBEo6Nq3RM', 'laravisions'), // Tea Infuser Tumbler
  'HOM-011': u('photo-1579326882518-21eaa7893b02', 'white-table-lamp-on-brown-wooden-table-nPyUKODwjD8', 'chiklad'), // Rechargeable Reading Lamp
  'HOM-016': u('photo-1768839722882-d7300ee822bd', 'a66dwgqx0tE', 'sasun1990'), // Smart LED Bulb
  'HOM-012': u('photo-1643114786355-ff9e52736eab', 'a-black-and-white-photo-of-a-water-kettle-pVD5AIpHNhU', 'enginakyurt'), // Glass Electric Kettle
  'HOM-017': u('photo-1581348304131-9d03407316b7', 'green-and-black-kettle-on-brown-wooden-table-l1kT-_xXlfQ', 'edwardhowellphotography'), // Foldable Travel Kettle
  'HOM-013': u('photo-1564510182791-29645da7fac4', 'gray-and-white-mini-fan-on-white-surface-6KZcjJoaqNI', 'callmefred'), // Clip-on Desk Fan
  'HOM-019': u('photo-1601084195907-44baaa49dabd', 'metal-desk-fan-in-sunlit-room-MvCW2PE9Tbg', 'delaneyvan'), // Rechargeable Table Fan
  'BAG-007': u('photo-1594299447935-e5b840f54b9b', 'black-backpack-on-white-box-d-BTL93LsGg', 'ziontech'), // Anti-theft Backpack
  'BAG-008': u('photo-1655303219938-3a771279c801', 'a-black-bag-on-grass-GeGdEAo7g30', 'haupes'), // Rolltop Daypack
  'BAG-014': u('photo-1628493706712-984ef8073177', 'oexC63FEGOQ', 'anniespratt'), // Backpack Rain Cover
  'BAG-015': u('photo-1765516833058-c322c800fee1', 'a-backpack-with-supplies-and-potted-plants-GWzW-NVmSPY', 'rachjl'), // Kids School Bag
  'BAG-009': u('photo-1528921581519-52b9d779df2b', 'eNIAipH_Bcs', 'wezlar11'), // 16" Laptop Sleeve
  'BAG-010': u('photo-1644258559678-2eac1b8b79b6', 'U4NZb8Zmliw', 'alexanderdaniel'), // Toiletry Kit
  'BAG-017': u('photo-1553697388-94e804e2f0f6', 'person-holding-passports-0QcSnCM0aMc', 'spencerdavis'), // Passport Organiser
  'BAG-011': u('photo-1525103504173-8dc1582c7430', 'PpzBE1hWeGI', 'jediahowen'), // Cabin Duffel 30L
  'BAG-016': u('photo-1781514041306-489a8d346265', '7vRbOLuM9i0', 'kotehidze'), // Gym Duffel
  'BAG-012': u('photo-1594438499712-bfd8b9f34597', 'black-umbrella-with-water-droplets-cqUyb7Yoxj8', 'abijeason_photography'), // Windproof Umbrella
  'BAG-018': u('photo-1523772721666-22ad3c3b6f90', 'pink-umbrella-mODxn7mOzms', 'ewitsoe'), // Reverse-Fold Umbrella
  'BAG-013': u('photo-1788380117639-97dd7d6c138a', 'child-sleeping-by-airplane-window-QDHU0rYw0s8', 'letoloke'), // Inflatable Neck Pillow
  'BAG-019': u('photo-1758221056094-dd3012f1f5f9', 'headphones-and-eye-mask-on-wrinkled-fabric-yuoz3BvFGDI', 'mindandcoffee'), // Sleep Kit (Mask + Earplugs)
};

/** imageKey → photo. Keys in use: see the checklist in web/public/products/README.md. */
export const PHOTOS_BY_KEY: Record<string, Photo> = {
  buds: u('photo-1606741965326-cb990ae01bb2', 'white-apple-earpods-with-case-mru38VH7tII', 'insungpandora'),
  neckband: u('photo-1632247541401-3d4a8d516595', 'a-pair-of-headphones-sitting-on-top-of-a-white-surface-gBzaLpS5QZw', 'darkstone_16'),
  wired: u('photo-1632835746204-22f652dac3af', 'a-pair-of-black-earphones-sitting-on-top-of-a-white-surface-qhqFVkrArIA', 'behy_studio'),
  soundbar: u('photo-1604914416956-38b08c516877', 'black-flat-screen-tv-on-brown-wooden-table-2RyHepsRFqE', 'jonasleupe'),
  band: u('photo-1557935728-e6d1eaabe558', 'black-fitness-tracker-band-q8Emkm9ooig', 'fitnish'),
  watch: u('photo-1624096104992-9b4fa3a279dd', 'black-smart-watch-with-white-background-O43D6CYzxqM', 'obuol'),
  clip: u('photo-1503328427499-d92d1ac3d174', 'activity-tracker-reading-11-36-mo-21-QRWAdBCqysc', 'abrkett'),
  ring: u('photo-1746280978271-1ef1a2d9447f', 'a-smart-ring-is-displayed-on-a-clear-block-q9RluwaZp1E', 'baldselect'),
  cable: u('photo-1595756630452-736bc8ef3693', 'black-usb-cable-on-white-table-RWxeE7wu1T8', 'kommumikation'),
  powerbank: u('photo-1760708825913-65a50b3dc39b', 'white-power-bank-with-three-charging-cables-7JbgHNq4h4k', 'zelebb'),
  stand: u('photo-1617975426095-f073792aef15', 'black-android-smartphone-on-brown-wooden-table-S8xWhJFidWQ', 'nublson'),
  pad: u('photo-1615526675159-e248c3021d3f', 'white-round-plastic-frame-on-black-table-CWWa6f1EB5g', 'studioproper'),
  bottle: u('photo-1602143407151-7111542de6e8', 'green-bottle-on-white-table-reEySFadyJQ', 'joanofarts'),
  lunchbox: u('photo-1632142334511-8f24c3d3ae79', 'a-sandwich-in-a-metal-container-on-a-marble-table-J-Td0wZ_FgA', 'thisisjackcole'),
  mug: u('photo-1789276392869-8103c256a501', 'yellow-travel-mug-in-green-grass-cw78QJcjG-4', 'kalaniparker'),
  lamp: u('photo-1519219788971-8d9797e0928e', 'gray-balanced-arm-lamp-on-brown-wooden-table-3A4XZUopCJA', 'lishakov', 'left'),
  kettle: u('photo-1594213114663-d94db9b17125', 'stainless-steel-kettle-on-brown-wooden-table-lJHhM4D0wCU', 'lauraadaiphoto'),
  fan: u('photo-1793327470793-5a07bff20824', 'copper-desk-fan-with-wire-grille-Z1YCaqszTc4', 'tronovich'),
  backpack: u('photo-1553062407-98eeb64c6a62', 'black-backpack-on-white-floor-_H0fjILH5Vw', 'sunlingyan'),
  sleeve: u('photo-1763034179057-acad3a072568', 'a-dark-blue-briefcase-with-a-shoulder-strap-7FuEauq8cZs', 'montbold'),
  pouch: u('photo-1758798689719-5b554ac3b65a', 'hand-holding-small-brown-leather-pouch-with-keychain-GNlOZhAofBQ', 'donguyenkhanhs'),
  duffel: u('photo-1448582649076-3981753123b5', 'brown-duffel-bag-beside-white-and-brown-wooden-chair-9XiN0r2NWSM', 'erol'),
  umbrella: u('photo-1554219374-6d2c029f855e', 'yellow-umbrella-RnLqehREQr8', 'katherine1690'),
  pillow: u('photo-1706819399603-428b06afe3fc', 'a-close-up-of-a-pillow-on-an-airplane-y7xXK9OKQh0', 'frugalflyer'),
};

/**
 * Cut-out product images (transparent background) for the floating "commute kit" story.
 * From Wikimedia Commons, served from Wikimedia's thumbnail server (960 px). CC BY-SA files
 * must stay credited with their licence: KitStory renders these credits under the section.
 */
export interface Cutout extends Photo {
  license: 'CC0' | 'CC BY-SA 4.0';
}

const wm = (path: string, file: string, artist: string, license: Cutout['license']): Cutout => ({
  src: `https://thumb.wikimedia.org/wikipedia/commons/thumb/${path}/960px-${path.split('/').pop()}`,
  credit: `${artist}, ${license}, via Wikimedia Commons`,
  sourceUrl: `https://commons.wikimedia.org/wiki/File:${file}`,
  license,
});

export const CUTOUTS_BY_SKU: Record<string, Cutout> = {
  // Studio Over-Ear Headphones only (Kids Safe Headphones shares the imageKey but looks different).
  'AUD-003': wm('d/d8/Headphone-dynamic-premium.png', 'Headphone-dynamic-premium.png', 'Vijay Verma', 'CC0'),
};

export const CUTOUTS_BY_KEY: Record<string, Cutout> = {
  buds: wm('2/25/NEW_HighKey_Wireless_Earbuds.png', 'NEW_HighKey_Wireless_Earbuds.png', 'Trent Huss', 'CC BY-SA 4.0'),
  cable: wm(
    '5/5f/2026-08-22_UGreen-USB-C-Kabel_HOF1918_RAW-Export.png',
    '2026-08-22_UGreen-USB-C-Kabel_HOF1918_RAW-Export.png',
    'PantheraLeo1359531',
    'CC BY-SA 4.0',
  ),
  backpack: wm('4/42/HighKey_Backpack.png', 'HighKey_Backpack.png', 'Trent Huss', 'CC BY-SA 4.0'),
  watch: wm('1/1a/Mobvoi_Ticwatch_Pro_5%2C_Sandstone.png', 'Mobvoi_Ticwatch_Pro_5,_Sandstone.png', 'SeriouslyBored', 'CC0'),
};

export function cutoutFor(imageKey: string, sku?: string): Cutout | null {
  return (sku && CUTOUTS_BY_SKU[sku]) || CUTOUTS_BY_KEY[imageKey] || null;
}

export function photoFor(imageKey: string, sku?: string): Photo | null {
  return (sku && PHOTOS_BY_SKU[sku]) || PHOTOS_BY_KEY[imageKey] || null;
}

/** Every photo in use, for the credits list. */
export function allPhotos(): Photo[] {
  const seen = new Set<string>();
  return [...Object.values(PHOTOS_BY_SKU), ...Object.values(PHOTOS_BY_KEY)].filter((p) =>
    seen.has(p.src) ? false : (seen.add(p.src), true),
  );
}
