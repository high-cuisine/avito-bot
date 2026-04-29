import { describe, expect, it } from 'vitest';
import { validateChatEstimateFields } from './chat-estimate-validation.js';

describe('validateChatEstimateFields', () => {
  it('accepts complete sensible payload', () => {
    const r = validateChatEstimateFields({
      route: 'Санкт-Петербург — Москва',
      cargo: 'Строительная вата',
      weight: '300 кг',
      payment_method: 'Наличные',
    });
    expect(r.ok).toBe(true);
  });

  it('rejects empty route', () => {
    const r = validateChatEstimateFields({
      route: '',
      cargo: 'вата',
      weight: '1 т',
      payment_method: 'нал',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toContain('route');
      expect(r.message).toMatch(/Сохранение отклонено/);
    }
  });

  it('rejects generic cargo', () => {
    const r = validateChatEstimateFields({
      route: 'СПб — Москва',
      cargo: 'товар',
      weight: '500 кг',
      payment_method: 'безнал',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.vague).toContain('cargo');
  });

  it('rejects weight without digits', () => {
    const r = validateChatEstimateFields({
      route: 'А — Б',
      cargo: 'кирпич',
      weight: 'неизвестно',
      payment_method: 'наличные',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.vague).toContain('weight');
  });
});
