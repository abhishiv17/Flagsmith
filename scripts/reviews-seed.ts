/**
 * Demo reviews for the fictional catalogue, so the "reviews" version of the product_trust_signal
 * experiment has something to show on day one. Like the products and partner shops, they are made
 * up (source 'seed'). Real shoppers' reviews (source 'shopper') are never touched.
 *
 * Deterministic: every run gives each product the same reviews. Idempotent: re-running replaces
 * only the seed reviews.
 * Usage: npm run reviews:seed
 */
import 'dotenv/config';
import { closePool, getPool, withTx } from '../server/lib/db.js';

/** Small seeded PRNG (mulberry32), so the same product always gets the same reviews. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  'Aarav S.', 'Ananya R.', 'Rohan K.', 'Priya M.', 'Vikram N.', 'Sneha P.', 'Arjun D.', 'Kavya T.',
  'Rahul G.', 'Meera J.', 'Siddharth B.', 'Divya L.', 'Karthik V.', 'Neha A.', 'Aditya C.', 'Pooja H.',
  'Nikhil R.', 'Ishita S.', 'Manish P.', 'Shreya K.', 'Farhan Q.', 'Lakshmi N.', 'Harsh M.', 'Zoya F.',
];
const CITIES = ['BLR', 'MUM', 'DEL'];

type Pool = { good: string[]; ok: string[]; bad: string[] };

const GENERIC: Pool = {
  good: [
    'Exactly as described. Picked it up from the store the same day, which made all the difference.',
    'Good build quality for the price. Have been using it daily for a few weeks with no complaints.',
    'Bought it after checking it was in stock nearby. Works well and feels well made.',
    'Does what it says. Simple to set up and has held up fine so far.',
    'Great value. Compared prices across shops and this was the best deal in my city.',
  ],
  ok: [
    'Decent overall. Does the job, though the finish could be a little better for the price.',
    'Works fine, nothing special. Packaging was good and it arrived without any damage.',
    'Okay product. Took a while to get used to, but it is fine now.',
  ],
  bad: [
    'Not quite what I expected. It works, but I would look at other options first.',
    'Average quality. Had a small issue in the first week, but the store sorted it out.',
  ],
};

const BY_CATEGORY: Record<string, Pool> = {
  audio: {
    good: [
      'Sound is clear and the bass is punchy without being muddy. Battery easily lasts my commute all week.',
      'Pairs instantly with my phone and laptop. Calls sound clean even on a noisy street.',
      'Comfortable for long sessions. I wear them through the whole workday.',
    ],
    ok: ['Sound is good for the price. The case feels a bit plasticky.', 'Battery life is as advertised, but the app is basic.'],
    bad: ['Connection drops now and then when my phone is in my back pocket.'],
  },
  wearables: {
    good: [
      'Battery lasts almost a week and the step count matches my phone closely.',
      'Light enough that I forget I am wearing it. Sleep tracking is surprisingly useful.',
      'Notifications are quick and the screen is easy to read in sunlight.',
    ],
    ok: ['Tracks the basics well. The strap could be softer.'],
    bad: ['Heart-rate readings jump around during workouts.'],
  },
  'mobile-accessories': {
    good: [
      'Charges my phone fast and stays cool. Solid cable, does not fray.',
      'Fits perfectly and the buttons still click nicely. Good grip.',
      'Small enough to carry every day. Gets my phone from 20 to 80 percent quickly.',
    ],
    ok: ['Works as expected. Slightly bulkier than I hoped.'],
    bad: ['Charging speed is slower than advertised with my phone.'],
  },
  'home-kitchen': {
    good: [
      'Keeps tea hot for hours on my commute. Does not leak in the bag.',
      'Easy to clean and feels sturdy. Use it every single day.',
      'Good capacity and the lid seals properly. Worth it.',
    ],
    ok: ['Does the job. The lid is a little stiff to open.'],
    bad: ['Smaller than it looked in the photos.'],
  },
  'bags-travel': {
    good: [
      'Fits my laptop, lunch and a jacket with room to spare. Straps are comfortable.',
      'Survived a monsoon week with everything inside dry. Very happy.',
      'Lots of pockets and still looks smart for the office.',
    ],
    ok: ['Good bag, but the zips could be smoother.'],
    bad: ['Stitching on one strap started coming loose after a month.'],
  },
};

function poolFor(category: string): Pool {
  const c = BY_CATEGORY[category];
  if (!c) return GENERIC;
  return { good: [...c.good, ...GENERIC.good], ok: [...c.ok, ...GENERIC.ok], bad: [...c.bad, ...GENERIC.bad] };
}

async function main() {
  const pool = getPool();
  const { rows: products } = await pool.query<{ id: number; category: string }>('SELECT id, category FROM products ORDER BY id');
  const now = Date.now();
  const rows: { productId: number; rating: number; body: string; name: string; city: string; at: string }[] = [];

  for (const p of products) {
    const rand = rng(p.id * 7919);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    const texts = poolFor(p.category);
    const count = 3 + Math.floor(rand() * 20); // 3 … 22 reviews
    const lean = rand(); // some products are simply better liked than others
    const used = new Set<string>();
    for (let i = 0; i < count; i++) {
      const roll = rand() * 0.75 + lean * 0.25;
      const rating = roll > 0.42 ? 5 : roll > 0.22 ? 4 : roll > 0.1 ? 3 : roll > 0.04 ? 2 : 1;
      const bank = rating >= 4 ? texts.good : rating === 3 ? texts.ok : texts.bad;
      let body = pick(bank);
      for (let tries = 0; used.has(body) && tries < 5; tries++) body = pick(bank);
      if (used.has(body)) continue; // keep each product's reviews distinct
      used.add(body);
      const daysAgo = Math.floor(rand() * 60) + 1;
      rows.push({ productId: p.id, rating, body, name: pick(NAMES), city: pick(CITIES), at: new Date(now - daysAgo * 86_400_000).toISOString() });
    }
  }

  await withTx(async (c) => {
    await c.query(`DELETE FROM product_reviews WHERE source = 'seed'`);
    await c.query(
      `INSERT INTO product_reviews (product_id, rating, body, author_name, city_code, source, created_at)
       SELECT (r->>'productId')::int, (r->>'rating')::smallint, r->>'body', r->>'name', r->>'city', 'seed', (r->>'at')::timestamptz
         FROM jsonb_array_elements($1::jsonb) AS r`,
      [JSON.stringify(rows)],
    );
  });
  console.log(`reviews:seed: ${rows.length} demo reviews across ${products.length} products`);
}

main()
  .catch((e) => {
    console.error('reviews:seed failed:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closePool());
