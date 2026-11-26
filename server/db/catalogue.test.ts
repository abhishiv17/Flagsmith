import { describe, expect, it } from 'vitest';
import { CITIES, PRODUCTS } from './catalogue.js';

describe('seed catalogue', () => {
  it('has one definition per SKU and usable stock in every city', () => {
    expect(new Set(PRODUCTS.map((p) => p.sku)).size).toBe(PRODUCTS.length);
    for (const product of PRODUCTS) {
      expect(product.name).toBeTruthy();
      expect(product.description).toBeTruthy();
      for (const city of CITIES) expect(product.stock[city.code]).toBeGreaterThanOrEqual(0);
    }
  });
});
