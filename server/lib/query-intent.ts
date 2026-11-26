import { USES, type Use } from '../db/catalogue-details.js';
import { addKnownWords, correctTypos } from './spell.js';

/**
 * Search like you talk (doc/19): pull the structured bits out of a sentence, leave the rest for
 * OpenSearch's full-text match.
 *   "something to keep my tea hot on the commute under 800 in stock"
 *   → text "keep tea hot", maxPrice ₹800, uses [commute], inStock
 *   "gift for my dad"           → for Dad: smartwatch, care watch, car charger… (no kids' items)
 *   "my phone keeps dying"      → looking for power banks & chargers
 *   "what should i buy my gf"   → filler dropped, for a partner: smart ring, earbuds…
 * Everything found is echoed back to the shopper as removable chips, so nothing is hidden magic.
 */

export interface Expansion {
  /** Chip key, so the shopper can remove it. */
  key: string;
  /** Words OpenSearch should look for (product names, tags, features). */
  terms: string;
  /** How much these words count against the shopper's own words. */
  boost: number;
}

export interface Intent {
  text: string;
  minPrice?: number; // paise
  maxPrice?: number; // paise
  inStock?: boolean;
  uses: Use[];
  city?: 'BLR' | 'MUM' | 'DEL';
  cheapestFirst?: boolean;
  /** Words the sentence implies (who it's for, what problem it solves). */
  expand: Expansion[];
  /** A grown-up is the recipient: leave kids' products out. */
  adultsOnly?: boolean;
  /** "Only 1 left", "last one", "few left": stock between 1 and this. */
  maxLeft?: number;
  /** The sentence as understood, for meaning search: typos fixed, price/stock/city words removed. */
  semanticText: string;
  /** Set when typos were fixed: what we actually searched for. */
  corrected?: string;
  /** doc/19: "black", "30 hour battery", "long battery" (filters, like marketplace facets). */
  colour?: string;
  minBatteryHours?: number;
  /** Human-readable chips: what we understood. */
  understood: { key: string; label: string }[];
}

const USE_WORDS: [RegExp, Use][] = [
  [/\b(commut\w*|metro|office commute|bus ride|daily travel|on the go)\b/, 'commute'],
  [/\b(gym|workout|work out|running|runner|run|jog\w*|fitness|exercise|sport\w*|cycling|yoga)\b/, 'workout'],
  [/\b(travel\w*|trips?|flights?|vacations?|holidays?|journeys?|suitcases?|abroad|honeymoon)\b/, 'travel'],
  [/\b(wfh|work from home|home office|desk|zoom|meetings?|calls)\b/, 'wfh'],
  [/\b(study|studying|student\w*|college|exams?|hostel|school)\b/, 'study'],
  [/\b(kids?|child|children|toddler|son|daughter|nephew|niece|baby|babies)\b/, 'kids'],
  [/\b(gift\w*|present|birthday|bday|anniversary|diwali|rakhi|raksha bandhan|christmas|xmas|valentine\w*|secret santa|housewarming|farewell|wedding|baby shower)\b/, 'gift'],
  [/\b(rain\w*|monsoon|waterproof|wet)\b/, 'monsoon'],
  [/\b(party|parties|karaoke|dance|house party)\b/, 'party'],
  [/\b(sleep\w*|bedtime|night|snor\w*|insomnia)\b/, 'sleep'],
  [/\b(trek\w*|camp\w*|hik\w*|outdoor\w*|beach)\b/, 'outdoor'],
  [/\b(kitchen|cooking|cook)\b/, 'kitchen'],
  [/\b(parents|grandparents?|grand ?(ma|pa|mother|father)|nani|dadi|nana|dada|elderly|senior\w*|old age)\b/, 'parents'],
];

/**
 * Who it's for. Each recipient pulls the products that suit them up the list; nothing is hidden.
 * `adult`: kids' products are left out. `uses`: occasions that recipient implies.
 */
const RECIPIENTS: { key: string; label: string; re: RegExp; terms: string; uses?: Use[]; adult?: boolean }[] = [
  { key: 'for:partner', label: 'For your partner', adult: true, uses: ['gift'],
    re: /\b(gf|girl ?friend|bf|boy ?friend|wife|husband|hubby|wifey|partner|fianc[eé]e?|spouse|bae|valentine\w*|anniversary|her|him)\b/,
    terms: 'smart ring smartwatch wireless earbuds noise cancelling headphones party speaker wireless charger' },
  { key: 'for:mom', label: 'For Mom', adult: true, uses: ['gift'],
    re: /\b(mom|mum|mummy|mommy|mother|maa|amma|mother'?s day)\b/,
    terms: 'care watch sos smartwatch glass electric kettle reading lamp ceramic mug set neckband sleep kit' },
  { key: 'for:dad', label: 'For Dad', adult: true, uses: ['gift'],
    re: /\b(dad|daddy|papa|father|appa|pappa|father'?s day)\b/,
    terms: 'smartwatch care watch car charger power bank neckband soundbar vacuum flask anti-theft backpack' },
  { key: 'for:grandparent', label: 'For grandparents', adult: true, uses: ['gift', 'parents'],
    re: /\b(grandparents?|grand ?(ma|pa|mother|father)|granny|nani|dadi|nana|dada|elderly|senior citizens?)\b/,
    terms: 'care watch sos reading lamp kettle neckband smart led bulb' },
  { key: 'for:friend', label: 'For a friend', adult: true, uses: ['gift'],
    re: /\b(friends?|bestie|bff|buddy|colleagues?|co-?workers?|boss|manager|roommates?|flatmates?|teachers?|secret santa|sister|sis|brother|bro|siblings?|cousins?)\b/,
    terms: 'pocket speaker power bank tumbler insulated mug wireless charging pad earbuds' },
  { key: 'for:kid', label: 'For a kid', uses: ['gift', 'kids'],
    re: /\b(kids?|child|children|toddler|son|daughter|nephew|niece|little one|baby|babies)\b/,
    terms: 'kids headphones kids buds kids gps watch step buddy school bag sipper' },
  { key: 'for:teen', label: 'For a teen or student', adult: true, uses: ['study'],
    re: /\b(teen\w*|student|college|hostel)\b/,
    terms: 'earbuds smartwatch power bank backpack laptop sleeve desk lamp' },
  { key: 'for:gamer', label: 'For a gamer', adult: true,
    re: /\b(gam(er|ers|ing)|esports?|ps5|xbox|console|streamer)\b/,
    terms: 'gaming earphones over-ear headphones usb-c hub desk speaker' },
  { key: 'for:techie', label: 'For a tech lover', adult: true,
    re: /\b(tech(ie|y)?|geek|nerd|gadgets?|gizmos?|cool stuff|cool tech|latest)\b/,
    terms: 'smart ring smartwatch noise cancelling anc earbuds 3-in-1 wireless charger gan charger smart led bulb usb-c hub' },
  { key: 'for:traveller', label: 'For a traveller', adult: true, uses: ['travel'],
    re: /\b(travell?ers?|backpackers?|wanderlust|frequent flyer)\b/,
    terms: 'travel anc headphones neck pillow passport organiser cabin duffel power bank' },
  { key: 'for:fitness', label: 'For a fitness fan', adult: true, uses: ['workout'],
    re: /\b(fitness (freak|fan|lover)|gym (rat|lover|goer)|athlete|runner|marathon)\b/,
    terms: 'fitness band sport buds open-ear runner gym duffel swim band smartwatch' },
];

/** Problems and needs, said the way people say them, mapped to what solves them. */
const NEEDS: { key: string; label: string; re: RegExp; terms: string; uses?: Use[] }[] = [
  { key: 'need:battery', label: 'Power banks & chargers',
    re: /\b(battery|batteries|(phone|mobile) (keeps |is )?(dying|dead|dies|off)|dying phone|low (battery|charge)|out of charge|charg(e|ing|er)s?|power cuts?|no power|juice)\b/,
    terms: 'power bank charger fast charging cable' },
  { key: 'need:music', label: 'Earbuds, headphones & speakers',
    re: /\b(music|songs?|listen\w*|podcasts?|audiobooks?|spotify|beats|bass|tunes)\b/,
    terms: 'earbuds headphones speaker neckband' },
  { key: 'need:noise', label: 'Noise cancelling',
    re: /\b(noise|noisy|loud|quiet|focus|concentrat\w*|block out|distract\w*)\b/,
    terms: 'noise cancelling anc headphones earbuds earplugs' },
  { key: 'need:calls', label: 'Clear calls',
    re: /\b(calls?|mic|microphone|meetings?|zoom|teams)\b/,
    terms: 'mic calls earbuds neckband headphones' },
  { key: 'need:home', label: 'For a new home',
    re: /\b(new (home|house|flat|apartment|place)|apartment|flat|housewarming|moving (in|out|house)|shifting|first home|hostel room|room decor)\b/,
    terms: 'electric kettle desk lamp smart led bulb mug set table fan speaker' , uses: ['kitchen'] },
  { key: 'need:hot', label: 'Keeps drinks hot or cold',
    re: /\b(hot|warm|cold|chilled|coffee|tea|chai|drinks?|hydrat\w*|water)\b/,
    terms: 'insulated flask mug tumbler bottle kettle' },
  { key: 'need:heat', label: 'Beat the heat',
    re: /\b(summer|heat|sweat\w*|humid\w*|too hot|fan|cooler|cooling)\b/,
    terms: 'fan rechargeable table fan usb mini fan clip-on fan' },
  { key: 'need:light', label: 'Lights & lamps',
    re: /\b(dark|light(ing)?|lamp|reading|read|bulb|eyes? strain)\b/,
    terms: 'lamp reading lamp smart led bulb desk lamp' },
  { key: 'need:posture', label: 'Desk comfort',
    re: /\b(back (pain|hurts?|ache)|neck (pain|hurts?|ache)|posture|ergonomic\w*|screen height)\b/,
    terms: 'stand tablet stand neck pillow desk' },
  { key: 'need:track', label: 'Trackers & GPS',
    re: /\b(los(e|ing|t)|misplac\w*|find(ing)? my|where (is|are)|gps|safety|safe|sos|fall|location|tracking|keys?|wallet)\b/,
    terms: 'gps tracker sos care watch' },
  { key: 'need:health', label: 'Health & fitness tracking',
    re: /\b(health\w*|steps?|heart ?rate|bp|spo2|calories|weight|lose weight|fit|stay fit|fitness (tracker|band|watch)|tracker|smart ?watch|smart ?ring)\b/,
    terms: 'fitness band smartwatch smart ring step tracker' },
  { key: 'need:laptop', label: 'Laptop & desk gear',
    re: /\b(laptop|macbook|work|office|ports?|dongle|hdmi|monitor)\b/,
    terms: 'laptop sleeve usb-c hub gan charger desk stand' },
  { key: 'need:car', label: 'For the car or bike',
    re: /\b(car|drive|driving|road trip|bike|scooter|ride|riding)\b/,
    terms: 'car charger car vent holder bike phone mount' },
  { key: 'need:food', label: 'Lunch & tiffin',
    re: /\b(lunch|tiffin|food|meals?|dabba|office food|eat\w*)\b/,
    terms: 'lunch box tiffin electric lunch box' },
  { key: 'need:carry', label: 'Bags',
    re: /\b(carry|bag|bags|pack|luggage|stuff to carry)\b/,
    terms: 'backpack duffel sleeve pouch' },
  { key: 'need:phone', label: 'Phone holders & cases',
    re: /\b(hold(er|ing)? (my )?phone|hands[- ]free|selfie|video calls?|watch(ing)? videos?|reels|netflix)\b/,
    terms: 'phone stand holder mount' },
];

const CITY_WORDS: [RegExp, Intent['city'], string][] = [
  [/\b(?:(?:in|at|from|near|around)\s+)?(?:bengaluru|bangalore|blr)\b/, 'BLR', 'Bengaluru'],
  [/\b(?:(?:in|at|from|near|around)\s+)?(?:mumbai|bombay)\b/, 'MUM', 'Mumbai'],
  [/\b(?:(?:in|at|from|near|around)\s+)?(?:new delhi|delhi|ncr)\b/, 'DEL', 'Delhi'],
];

/** Words that carry no product meaning in a sentence ("what should i buy my…"). */
const FILLER = new Set(`a an the for on to with of and or but in at by from i im i'm me my mine we our us you your u
  he she they them their his it its this that these those is are was be been am do does did can could would should
  will shall may might must want wanted wanna need needs needed looking look find show give get got getting buy buying
  bought order purchase shop shopping some something anything thing things stuff item items product products idea ideas
  suggest suggestion suggestions recommend recommendation recommendations please pls plz help hi hey hello what which who
  whom where when why how any good best nice great cool awesome perfect ideal great really very so just also like love
  loves liked who's what's one ones keeps keep kept getting gets always never sometimes every new old year years yr yrs
  around about maybe kind sort type types under over than more less much many few go going gonna lot lots`.split(/\s+/));

const rupees = (s: string) => {
  const k = /k$/i.test(s);
  const n = Number(s.replace(/[k,]/gi, ''));
  return Math.round((k ? n * 1000 : n) * 100);
};
const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;
const AMOUNT = '(?:₹|rs\\.?|inr)?\\s*(\\d[\\d,]*(?:\\.\\d+)?k?)';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Everything the parser itself understands is "known" to the typo fixer (so "want" never becomes "warm").
addKnownWords(FILLER);
addKnownWords([...USE_WORDS.map(([re]) => re), ...RECIPIENTS.map((r) => r.re), ...NEEDS.map((n) => n.re), ...CITY_WORDS.map(([re]) => re)]
  .flatMap((re) => re.source.replace(/\\[a-z]/g, ' ').match(/[a-z]{2,}/g) ?? []));
addKnownWords(['only', 'left', 'last', 'remaining', 'few', 'unit', 'units', 'piece', 'pieces', 'gf', 'bf', 'bday', 'pls', 'plz', 'rs', 'inr']);

export function parseIntent(raw: string): Intent {
  const clean = raw.toLowerCase().replace(/[’']/g, "'").replace(/[^\p{L}\p{N}₹.,'\- ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const fixed = correctTypos(clean);
  let q = ` ${fixed} `;
  const it: Intent = { text: '', uses: [], expand: [], understood: [], semanticText: '' };
  if (fixed !== clean) it.corrected = fixed;
  const cut = (re: RegExp) => { q = q.replace(re, ' '); };
  const addUse = (use: Use) => {
    if (it.uses.includes(use)) return;
    it.uses.push(use);
    it.understood.push({ key: `use:${use}`, label: `Good for: ${USES[use]}` });
  };

  // Age: "for my 10 year old" → kid / teen / grandparent. Cut before prices so "10" isn't ₹10.
  let age: number | undefined;
  const ageM = q.match(/\b(\d{1,2})\s*-?\s*(?:years?|yrs?|yo|y\/o)\s*-?\s*(?:old)?\b/);
  if (ageM) { age = Number(ageM[1]); cut(new RegExp(esc(ageM[0]))); }

  // Price: between A and B / A-B / under B / over A / "500 rupees"
  let m = q.match(new RegExp(`\\b(?:between|from)\\s+${AMOUNT}\\s*(?:and|to|-)\\s*${AMOUNT}`));
  if (m) {
    it.minPrice = rupees(m[1]!); it.maxPrice = rupees(m[2]!); cut(new RegExp(esc(m[0])));
  } else if ((m = q.match(new RegExp(`(?:₹|rs\\.?)\\s*(\\d[\\d,]*k?)\\s*(?:-|to)\\s*(?:₹|rs\\.?)?\\s*(\\d[\\d,]*k?)`)))) {
    it.minPrice = rupees(m[1]!); it.maxPrice = rupees(m[2]!); cut(new RegExp(esc(m[0])));
  } else {
    if ((m = q.match(new RegExp(`\\b(?:under|below|less than|upto|up to|within|max|maximum|cheaper than|not more than|budget(?: of| is)?|<)\\s*${AMOUNT}(?:\\s*(?:rupees|rs|bucks|inr))?`)))) {
      it.maxPrice = rupees(m[1]!); cut(new RegExp(esc(m[0])));
    } else if ((m = q.match(/(?:₹|rs\.?\s*)(\d[\d,]*k?)\b|\b(\d[\d,]*k?)\s*(?:rupees|rs|bucks|inr)\b/))) {
      it.maxPrice = rupees((m[1] ?? m[2])!); cut(new RegExp(esc(m[0]))); // "a 500 rupee gift": treat as a budget
    }
    if ((m = q.match(new RegExp(`\\b(?:over|above|more than|at least|min|minimum|>)\\s*${AMOUNT}`)))) {
      it.minPrice = rupees(m[1]!); cut(new RegExp(esc(m[0])));
    }
  }
  // "Secret santa", "small gift", "stocking filler": a small budget unless one was given.
  if (it.maxPrice === undefined && /\b(secret santa|stocking filler|small gift|token gift|return gifts?)\b/.test(q)) {
    it.maxPrice = 100_000;
  }
  if (it.minPrice !== undefined && it.maxPrice !== undefined) it.understood.push({ key: 'price', label: `${inr(it.minPrice)}–${inr(it.maxPrice)}` });
  else if (it.maxPrice !== undefined) it.understood.push({ key: 'price', label: `Under ${inr(it.maxPrice)}` });
  else if (it.minPrice !== undefined) it.understood.push({ key: 'price', label: `Over ${inr(it.minPrice)}` });
  if (/\b(cheap|cheapest|budget|affordable|low cost|inexpensive|economical|value for money)\b/.test(q)) {
    it.cheapestFirst = true; cut(/\b(cheap|cheapest|budget|affordable|low cost|inexpensive|economical|value for money)\b/g);
    it.understood.push({ key: 'cheap', label: 'Cheapest first' });
  }
  if (/\b(premium|luxury|expensive|high[- ]end|best quality|top end|fancy|splurge)\b/.test(q)) {
    cut(/\b(premium|luxury|expensive|high[- ]end|best quality|top end|fancy|splurge)\b/g);
    if (it.minPrice === undefined) {
      it.minPrice = 250_000;
      it.understood.push({ key: 'price', label: `Over ${inr(it.minPrice)}` });
    }
  }

  // Last units: "only 1 left", "last one", "just one remaining", "few left", "almost sold out".
  const one = /\b(?:(?:only|just)\s+)?(?:1|one)\s+(?:items?\s+|units?\s+|pieces?\s+|pcs?\s+)?(?:left|remaining|in stock|stock(?:\s+products?)?)\b|\b(?:stock\s+(?:of\s+)?(?:1|one)|products?\s+(?:with|having)\s+(?:(?:1|one)\s+(?:in\s+)?stock|stock\s+(?:of\s+)?(?:1|one)|(?:1|one)))\b|\blast\s+(?:one|unit|piece|item)s?(?:\s+(?:left|remaining|in stock))?\b|\b(?:only|just)\s+(?:1|one)\b/;
  const two = /\b(?:(?:only|just)\s+)?(?:2|two|couple of)\s+(?:items?\s+|units?\s+|pieces?\s+|pcs?\s+)?(?:left|remaining|in stock|stock(?:\s+products?)?)\b|\b(?:stock\s+(?:of\s+)?(?:2|two)|products?\s+(?:with|having)\s+(?:(?:2|two)\s+(?:in\s+)?stock|stock\s+(?:of\s+)?(?:2|two)|(?:2|two)))\b/;
  const few = /\b(?:few|couple)\s+(?:items?\s+|units?\s+)?(?:left|remaining)\b|\balmost\s+(?:gone|sold out|out of stock)\b|\b(?:low|limited)\s+stock\b|\brunning\s+out\b|\blast\s+(?:few|units|pieces)\b|\bselling\s+fast\b/;
  if (one.test(q)) {
    it.maxLeft = 1; cut(new RegExp(one.source, 'g'));
    it.understood.push({ key: 'left', label: 'Only 1 left' });
  } else if (two.test(q)) {
    it.maxLeft = 2; cut(new RegExp(two.source, 'g'));
    it.understood.push({ key: 'left', label: 'Only 2 left' });
  } else if (few.test(q)) {
    it.maxLeft = 3; cut(new RegExp(few.source, 'g'));
    it.understood.push({ key: 'left', label: 'Only a few left' });
  }

  // Battery: "30 hour battery", "battery 20h+", "long battery (life)".
  {
    const b = q.match(/\b(\d{1,3})\s*(?:\+\s*)?(?:h|hr|hrs|hours?)\b(?:\s*\+)?(?:\s*(?:of\s+)?(?:battery|playback|play ?time|backup))?/);
    if (b && /battery|playback|play ?time|backup|\d\s*(?:h|hrs?|hours?)\b/.test(b[0])) {
      it.minBatteryHours = Number(b[1]); cut(new RegExp(b[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      it.understood.push({ key: 'battery', label: `Battery ${it.minBatteryHours} h+` });
    } else if (/\b(long|big|great|best) battery( life)?\b|\blong[- ]lasting\b/.test(q)) {
      it.minBatteryHours = 24; cut(/\b(long|big|great|best) battery( life)?\b|\blong[- ]lasting\b/g);
      it.understood.push({ key: 'battery', label: 'Battery 24 h+' });
    }
  }
  // Colour: a filter, like a marketplace colour facet.
  for (const c of ['black', 'white', 'grey', 'gray', 'silver', 'blue', 'navy', 'red', 'pink', 'green', 'yellow', 'orange', 'brown', 'teal']) {
    if (new RegExp(`\\b${c}\\b`).test(q)) {
      it.colour = c === 'gray' ? 'grey' : c; cut(new RegExp(`\\b${c}\\b`, 'g'));
      it.understood.push({ key: 'colour', label: `Colour: ${it.colour}` });
      break;
    }
  }

  // Availability: the StockHop part.
  if (/\b(in stock|available|today|tonight|right now|now|near me|nearby|in hand|same day|urgent\w*|asap|last minute)\b/.test(q)) {
    it.inStock = true; cut(/\b(in stock|available|today|tonight|right now|now|near me|nearby|in hand|same day|urgent\w*|asap|last minute)\b/g);
    it.understood.push({ key: 'stock', label: 'In stock now' });
  }

  for (const [re, city, name] of CITY_WORDS) {
    if (re.test(q)) { it.city = city; cut(re); it.understood.push({ key: 'city', label: `In ${name}` }); break; }
  }

  // Who it's for. An age decides between kid, teen and grandparent.
  const who = RECIPIENTS.filter((r) => r.re.test(q));
  if (age !== undefined) {
    const key = age <= 12 ? 'for:kid' : age <= 19 ? 'for:teen' : age >= 60 ? 'for:grandparent' : null;
    const r = RECIPIENTS.find((x) => x.key === key);
    if (r && !who.includes(r)) who.unshift(r);
  }
  // A specific recipient beats the generic "tech lover" ("gadgets for a gamer" → gaming gear).
  if (who.length > 1) who.splice(0, who.length, ...who.filter((r) => r.key !== 'for:techie'));
  for (const r of who.slice(0, 2)) {
    it.expand.push({ key: r.key, terms: r.terms, boost: 1.5 });
    it.understood.push({ key: r.key, label: r.label });
    for (const u of r.uses ?? []) addUse(u);
  }
  it.adultsOnly = who.length > 0 && who.every((r) => r.adult);

  // Occasions: boost, don't hide (the words also stay in the text, they're meaningful).
  for (const [re, use] of USE_WORDS) {
    if (re.test(q) && !(use === 'kids' && it.adultsOnly)) addUse(use);
  }

  // Needs: "my phone keeps dying" → power banks and chargers.
  for (const n of NEEDS) {
    if (!n.re.test(q)) continue;
    it.expand.push({ key: n.key, terms: n.terms, boost: 3 });
    it.understood.push({ key: n.key, label: `Looking for: ${n.label}` });
    for (const u of n.uses ?? []) addUse(u);
    if (it.expand.filter((e) => e.key.startsWith('need:')).length >= 3) break;
  }

  // The sentence for meaning search: what's left after prices, stock and city came out (typos fixed).
  it.semanticText = q.replace(/[₹]/g, ' ').replace(/\s+/g, ' ').trim();

  // Who it's for is a hint; what they asked for ("loves running", "fitness tracker") comes first.
  const said = (s: string) => s.split(/\s+/).filter((w) => w && !FILLER.has(w) && w.length > 1);
  let rest = q;
  for (const r of who) rest = rest.replace(new RegExp(r.re.source, 'g'), ' ');
  rest = rest.replace(/\b(gift\w*|present\w*|birthday|bday|anniversary)\b/g, ' ');
  const specific = it.expand.some((e) => e.key.startsWith('need:')) ||
    it.uses.some((u) => !['gift', 'kids', 'parents', 'study'].includes(u)) || said(rest).length > 0;
  if (specific) for (const e of it.expand) if (e.key.startsWith('for:')) e.boost = 0.6;

  // What's left for full text: drop filler and the recipient words (they're chips now, and
  // "dad" would otherwise fuzzy-match "pad").
  for (const r of who) cut(new RegExp(r.re.source, 'g'));
  it.text = q
    .replace(/[₹,.]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w) && !/^\d+$/.test(w) && w.length > 1)
    .join(' ');
  return it;
}
