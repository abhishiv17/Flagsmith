import { describe, expect, it } from 'vitest';
import { completionsFrom } from './suggest.js';

const names = [
  'Phone Stand Aluminium', 'Phone Holder for Car', 'Phone Grip Ring', 'Magnetic Phone Stand',
  'Photo Printer Mini', 'Noise Cancelling Headphones', 'Travel ANC Headphones', 'Bluetooth Speaker Mini',
];

describe('completionsFrom', () => {
  it('completes a partial word, most common first', () => {
    const out = completionsFrom('pho', names).map((c) => c.text);
    expect(out[0]).toBe('phone');
    expect(out).toContain('phone stand');
    expect(out).toContain('photo');
  });

  it('keeps the words already typed in front', () => {
    const out = completionsFrom('noise c', names).map((c) => c.text);
    expect(out[0]).toBe('noise cancelling');
  });

  it('treats hyphenated names as separate words', () => {
    expect(completionsFrom('noise c', ['Noise-Cancelling USB Headset']).map((c) => c.text)).toContain('noise cancelling');
  });

  it('matches earlier words as prefixes too', () => {
    expect(completionsFrom('blu spe', names).map((c) => c.text)).toContain('bluetooth speaker');
  });

  it('offers the next word after a trailing space', () => {
    const out = completionsFrom('phone ', names).map((c) => c.text);
    expect(out).toEqual(expect.arrayContaining(['phone stand', 'phone holder', 'phone grip']));
  });

  it('never suggests exactly what was typed', () => {
    expect(completionsFrom('phone', names).map((c) => c.text)).not.toContain('phone');
  });
});
