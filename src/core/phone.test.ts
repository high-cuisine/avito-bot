import { describe, expect, it } from 'vitest';
import { normalizePhone } from './phone.js';

describe('normalizePhone', () => {
  it('normalizes 8… to +7', () => {
    expect(normalizePhone('8 (903) 123-45-67')).toBe('+79031234567');
  });

  it('normalizes 7… 11 digits to +7…', () => {
    expect(normalizePhone('79031234567')).toBe('+79031234567');
  });

  it('normalizes 10 digits to +7', () => {
    expect(normalizePhone('9031234567')).toBe('+79031234567');
  });

  it('returns null for garbage', () => {
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('123')).toBeNull();
  });
});
