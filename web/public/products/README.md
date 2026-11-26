# Product photos

Drop free stock photos here (Unsplash or Pexels licence), then register each one in
`web/src/productPhotos.ts` with its credit. Products without a photo keep their illustration.

**Look for:** product centred, plain light-grey or white background, soft studio light, no visible
brand logos, no people's faces. Save as JPG, about 1200 px wide, under ~250 KB.

## Checklist (30 products, 27 image keys)

Register by **SKU** where two products share an image key, otherwise by **image key**.

| Register as | Product | Search terms that work |
|---|---|---|
| `buds` | Everyday Buds | wireless earbuds case white background |
| `AUD-002` | Pocket Speaker | small bluetooth speaker |
| `AUD-005` | Bass Cube Speaker | cube speaker |
| `AUD-003` | Studio Over-Ear Headphones | over-ear headphones studio |
| `AUD-007` | Kids Safe Headphones | colourful kids headphones |
| `neckband` | Neckband Pro | neckband earphones |
| `wired` | Classic Wired Earphones | wired earphones |
| `soundbar` | Soundbar Mini | soundbar |
| `band` | Pulse Fitness Band | fitness tracker band |
| `watch` | Orbit Smartwatch | smartwatch white background |
| `clip` | Step Clip Tracker | clip-on step tracker / pedometer |
| `ring` | Halo Smart Ring | smart ring |
| `MOB-001` | 20W Fast Charger | usb-c wall charger |
| `MOB-005` | Car Charger Duo | car charger |
| `cable` | Braided USB-C Cable | braided usb cable |
| `powerbank` | 10000mAh Power Bank | power bank |
| `stand` | MagGrip Phone Stand | phone stand desk |
| `pad` | Wireless Charging Pad | wireless charging pad |
| `bottle` | Travel Bottle | steel water bottle |
| `lunchbox` | Steel Lunch Box | steel lunch box / bento |
| `mug` | Insulated Coffee Mug | insulated travel mug |
| `lamp` | LED Desk Lamp | led desk lamp |
| `kettle` | Electric Kettle 1.5L | electric kettle |
| `fan` | USB Mini Fan | usb desk fan |
| `backpack` | Commuter Backpack | minimal backpack |
| `sleeve` | 14" Laptop Sleeve | laptop sleeve |
| `pouch` | Travel Pouch Set | travel pouch organiser |
| `duffel` | Weekender Duffel | duffel bag |
| `umbrella` | Compact Umbrella | compact folding umbrella |
| `pillow` | Memory Foam Neck Pillow | travel neck pillow |

Check SKUs in `server/db/catalogue.ts` before registering by SKU.
