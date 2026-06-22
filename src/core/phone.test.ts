import { describe, expect, it } from 'vitest';
import { extractPhoneLikeDigits, normalizePhone, normalizePhoneFromMessage } from './phone.js';

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

describe('normalizePhoneFromMessage', () => {
  it('extracts explicit phone formats', () => {
    expect(normalizePhoneFromMessage('добрый день, мой номер 8 (900) 555-44-33')).toBe('+79005554433');
    expect(normalizePhoneFromMessage('добрый день, 89658824885')).toBe('+79658824885');
    expect(normalizePhoneFromMessage('не хочу давать, но вот телефон 89658824885')).toBe('+79658824885');
    expect(normalizePhoneFromMessage('позвоните мне на 89001234567 или на 89009876543')).toBe('+79001234567');
    expect(normalizePhoneFromMessage('+79031234567')).toBe('+79031234567');
  });

  it('does not treat scattered cargo digits as a phone', () => {
    const cargoSamples = [
      '19А Даска 45*145*4м - 11шт',
      'Брус 45*45*3 - 27шт',
      '3) 3л мадояна 316 ст Ростов-зададный 145*45*6 - 16шт',
      'груз: даска 45*145*4м - 11шт, брус 45*45*3 - 27шт',
      'мск спб, стекло, 2 тонны, 3 куба, наличка',
      'спб мск\n5 палетов\nналичка\nстекло',
      'откуда москва куда спб груз мебель 1.5 тонны 8 кубов',
      'маршрут москва - санкт-петербург, груз: паллеты 5 шт, вес 500 кг',
      [
        'доброго дня! Уточните, сможете за 4000-4500 руб собрать заказ?',
        'Все загрузят и выгрузят по минут на точке - 5 точек, 93км.',
        'загрузка',
        '!)аксайский проспект 19А Даска 45*145*4м - 11шт',
        '2) ул. Днепропетровская 52а',
        'Брус 45*45*3 - 27шт',
        '3) 3л мадояна 316 ст Ростов-зададный 145*45*6 - 16шт',
        'выгрузка',
        '5) ул. Изумрудная 9, пос Темерницкий, район Аксай',
      ].join('\n'),
      [
        'загрузка: аксайский проспект 19А',
        'загрузка: ул. Днепропетровская 52а',
        'выгрузка: ул. Изумрудная 9',
        'груз: даска 45*145*4м - 11шт, брус 45*45*3 - 27шт',
      ].join('\n'),
    ];
    for (const sample of cargoSamples) {
      expect(normalizePhoneFromMessage(sample), `false positive for: ${sample.slice(0, 60)}`).toBeNull();
    }
  });

  it('does not concatenate all message digits into a phone', () => {
    expect(normalizePhone('19А Даска 45*145*4м - 11шт')).toBe('+71945145411');
    expect(normalizePhoneFromMessage('19А Даска 45*145*4м - 11шт')).toBeNull();
  });
});

describe('extractPhoneLikeDigits', () => {
  it('returns digit count for malformed phone clusters', () => {
    expect(extractPhoneLikeDigits('мой номер 8 999 111 22 33 44')).toBe('8999111223344');
  });

  it('returns null when there is no phone-like cluster', () => {
    expect(extractPhoneLikeDigits('мск спб, стекло, 2 тонны')).toBeNull();
    expect(extractPhoneLikeDigits('45*145*4м - 11шт')).toBeNull();
  });
});
