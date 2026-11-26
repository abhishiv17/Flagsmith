import { describe, expect, it } from 'vitest';
import { parseIntent } from './query-intent.js';

const keys = (q: string) => parseIntent(q).understood.map((c) => c.key);
const expanded = (q: string) => parseIntent(q).expand.map((e) => e.key);

describe('parseIntent: search like you talk (doc/19)', () => {
  it('knows who a gift is for, and keeps kids’ items away from grown-ups', () => {
    for (const q of ['gifts for my gf', 'what should i buy my boyfriend', 'anniversary gift for husband']) {
      expect(expanded(q)).toContain('for:partner');
      expect(parseIntent(q).adultsOnly).toBe(true);
    }
    expect(expanded('gift for dad')).toContain('for:dad');
    expect(expanded('present for mom under 2000')).toContain('for:mom');
    expect(parseIntent('present for mom under 2000').maxPrice).toBe(200_000);
    expect(expanded('for my 10 year old nephew')).toContain('for:kid');
    expect(parseIntent('for my 10 year old nephew').adultsOnly).toBe(false);
    expect(expanded('gift for my 70 year old grandma')).toContain('for:grandparent');
    expect(expanded('gadgets for a gamer')).toEqual(['for:gamer']);
  });

  it('drops chat words and recipient words from the full-text part', () => {
    expect(parseIntent('what should i buy my boyfriend').text).toBe('');
    expect(parseIntent('gift for dad').text).toBe('gift'); // "dad" would fuzzy-match "pad"
    expect(parseIntent('i want to listen to music on the go').text).toBe('listen music');
  });

  it('turns problems into products', () => {
    expect(expanded('my phone keeps dying')).toContain('need:battery');
    expect(expanded('i want to listen to music on the go')).toContain('need:music');
    expect(expanded('stuff for my new apartment')).toContain('need:home');
    expect(expanded('i keep losing my keys')).toContain('need:track');
    expect(expanded('fitness tracker for wife')).toContain('need:health');
    expect(expanded('fitness tracker for wife')).not.toContain('need:track');
  });

  it('lets what they asked for outrank who it is for', () => {
    const generic = parseIntent('gift for dad').expand.find((e) => e.key === 'for:dad')!;
    const specific = parseIntent('earbuds for my dad').expand.find((e) => e.key === 'for:dad')!;
    expect(specific.boost).toBeLessThan(generic.boost);
  });

  it('reads budgets, ages and stock words', () => {
    expect(parseIntent('secret santa').maxPrice).toBe(100_000);
    expect(parseIntent('a 500 rupees gift').maxPrice).toBe(50_000);
    expect(parseIntent('for my 10 year old').maxPrice).toBeUndefined(); // an age, not ₹10
    expect(keys('diwali gifts under 1000 in stock')).toEqual(expect.arrayContaining(['price', 'stock', 'use:gift']));
    expect(parseIntent('premium gift for boss').minPrice).toBe(250_000);
    expect(parseIntent('two left in Delhi').maxLeft).toBe(2);
    expect(parseIntent('only 2 units remaining Mumbai').city).toBe('MUM');
    expect(parseIntent('only 2 units remaining Mumbai').maxLeft).toBe(2);
    expect(parseIntent('just one left Bangalore').maxLeft).toBe(1);
    for (const q of ['1 stock products', '1 in stock', 'stock of 1', 'products with 1 stock']) {
      expect(parseIntent(q).maxLeft).toBe(1);
      expect(parseIntent(q).text).toBe('');
    }
    expect(parseIntent('2 stock products').maxLeft).toBe(2);
    expect(parseIntent('headphones Delhi under 2k').maxPrice).toBe(200_000);
    expect(parseIntent('headphones Delhi under 2k').text).toBe('headphones');
  });

  it('keeps what already worked', () => {
    const t = parseIntent('something to keep my tea hot on the commute under 800 in stock');
    expect(t.maxPrice).toBe(80_000);
    expect(t.inStock).toBe(true);
    expect(t.uses).toContain('commute');
    expect(parseIntent('bluetoth earphones').text).toBe('bluetooth earphones'); // typo fixed before search
    expect(parseIntent('xyz qwerty').text).toBe('xyz qwerty'); // unknown words stay unknown
    expect(parseIntent('cheap power bank in mumbai').city).toBe('MUM');
  });
});
