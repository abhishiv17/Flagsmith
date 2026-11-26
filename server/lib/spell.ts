import { PRODUCTS } from '../db/catalogue.js';

/**
 * Typos and human errors (doc/19): "andre 500" → "under 500", "grilfriend" → "girlfriend",
 * "headfones" → "headphones", "chargr" → "charger". A word that isn't in our vocabulary (every word
 * in the catalogue plus the words the intent parser knows) is replaced by the closest known word,
 * within 1 edit for short words and 2 for longer ones (transpositions count as one edit).
 * The corrected sentence is shown to the shopper ("Showing results for …"), so nothing is hidden.
 */

/** Words the intent parser acts on: corrected first when there's a tie. */
const KEYWORDS = `under below above over between less than more upto within maximum minimum rupees budget cheap cheapest
  affordable premium expensive luxury gift gifts present presents birthday anniversary wedding valentine diwali rakhi christmas
  housewarming girlfriend boyfriend wife husband partner fiance mother father mom mum dad mummy papa sister brother friend
  friends bestie colleague boss teacher grandma grandpa grandmother grandfather grandparents parents kids kid child children
  daughter son nephew niece baby toddler teen teenager student college school office hostel gamer gaming techie traveller
  stock available left remaining only last few today tonight nearby urgent bengaluru bangalore mumbai delhi
  commute workout gym running travel trip flight monsoon rain party sleep outdoor kitchen music battery charging phone
  laptop noise headphones earphones earbuds speaker watch smartwatch bottle flask charger cable backpack umbrella
  personal care smart home fitness health camera computer gaming accessories wearables audio kitchen bags`.split(/\s+/);

const vocab = new Map<string, number>();
for (const k of KEYWORDS) if (k) vocab.set(k, 1_000);
for (const p of PRODUCTS) {
  const text = [p.name, p.brand, p.description, p.tags.join(' '), (p.features ?? []).join(' '), p.about ?? ''].join(' ').toLowerCase();
  for (const w of text.split(/[^a-z]+/)) if (w.length >= 3) vocab.set(w, (vocab.get(w) ?? 0) + 1);
}
/**
 * Everyday words people put in a search that aren't in our catalogue: they are real words, so they
 * are left alone (never "chill" → "child"), but they never become a fix for something else.
 */
const COMMON = `chill cool cute fun funny love lover lovely loving nice cozy comfy aesthetic vibe vibes style stylish classy
  simple small big tiny huge light heavy loud quiet fast slow long short new old young latest trendy fancy unique unusual random
  surprise thanks thank sorry please hello happy sad tired bored boring stress stressed relax relaxing calm lazy busy sick ill
  home house work job day days night nights morning evening weekend week month year summer winter spring autumn cold warm
  sweet spicy food drink drinks snack snacks movie movies film films series show shows song songs dance game games play
  playing played binge watch watching reading read book books cooking bake baking coffee tea chai beer wine juice
  netflix youtube instagram insta reels whatsapp amazon apple iphone android samsung ipad macbook alexa google spotify bgmi
  pubg minecraft fifa valorant cricket football badminton tennis yoga gym run walk walking hiking swim swimming cycle
  cycling dog dogs cat cats pet pets plant plants garden car cars bike bikes scooter train bus metro auto cab flight
  plane airport hotel beach mountain mountains hills goa manali office desk boss team meeting meetings call calls zoom
  class classes exam exams homework study college school university hostel room bedroom kitchen bathroom balcony terrace
  wedding shaadi party birthday festival holi diwali eid christmas rakhi valentine date dating couple couples married
  newlywed baby pregnant mother newborn grandma grandpa uncle aunty aunt cousin neighbour neighbor colleague roommate
  someone something anything everything nothing stuff things thing item items product products idea ideas option options
  under below above between around about approx budget cheap costly price prices rupees money worth value
  black white red blue green pink purple yellow orange grey gray silver gold rose brown colour color colours colors`.split(/\s+/);

const known = new Set<string>(COMMON.filter(Boolean));
const PRICE_WORDS = ['under', 'below', 'above', 'over', 'upto', 'within', 'between'];

/** Damerau-Levenshtein (optimal string alignment) distance, stopping early past `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

function closest(word: string, max: number, pool: Iterable<string> = vocab.keys(), sameInitial = false): string | null {
  let best: { w: string; d: number; p: number; s: number; f: number } | null = null;
  const prefix = (w: string) => { let i = 0; while (i < w.length && w[i] === word[i]) i++; return i; };
  const suffix = (w: string) => { let i = 0; while (i < w.length && i < word.length && w[w.length - 1 - i] === word[word.length - 1 - i]) i++; return i; };
  for (const w of pool) {
    // Two edits can turn an unfamiliar word into an unrelated catalogue term. For normal
    // queries, keep the first letter as an anchor; price words get their own contextual path.
    if (sameInitial && w[0] !== word[0]) continue;
    const d = distance(word, w, max);
    if (d > max) continue;
    const f = vocab.get(w) ?? 0;
    const p = prefix(w);
    // Fewer edits first; then more letters in common at the start (people get the start right:
    // "trimer" → trimmer, not timer); then words the parser knows / common in the catalogue.
    const s = suffix(w);
    const better = !best || d < best.d || (d === best.d && (p > best.p || (p === best.p && (s > best.s || (s === best.s && f > best.f)))));
    if (better) best = { w, d, p, s, f };
  }
  return best?.w ?? null;
}

/** Words the caller knows (the intent parser's filler and rule words): never corrected, preferred as fixes. */
export function addKnownWords(words: Iterable<string>) {
  for (const w of words) if (w.length >= 2) vocab.set(w, Math.max(vocab.get(w) ?? 0, 1_000));
}

/** Correct a lower-cased sentence. Returns the same string when nothing needed fixing. */
export function correctTypos(sentence: string): string {
  const words = sentence.split(' ');
  return words
    .map((w, i) => {
      if (!/^[a-z]+$/.test(w) || vocab.has(w) || known.has(w) || w.length < 4) return w;
      // Right before a number, it's very likely a price word: "andre 500", "bellow 2k", "udner 1000".
      if (/^[₹\d]/.test(words[i + 1] ?? '')) {
        const p = closest(w, 2, PRICE_WORDS);
        if (p) return p;
      }
      return closest(w, w.length <= 5 ? 1 : 2, vocab.keys(), true) ?? w;
    })
    .join(' ');
}
