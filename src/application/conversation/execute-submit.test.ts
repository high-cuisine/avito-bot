import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDatabaseForTests,
  getSession,
  saveClient,
  saveSession,
  upsertChatEstimateRequest,
} from '../../infrastructure/storage/repository.js';

vi.mock('../../integrations/webhook/submit-lead.js', () => ({
  postSubmitWebhook: vi.fn().mockResolvedValue(true),
}));

describe('execute-submit', () => {
  beforeEach(async () => {
    clearDatabaseForTests();
    vi.clearAllMocks();
    const { postSubmitWebhook } = await import('../../integrations/webhook/submit-lead.js');
    vi.mocked(postSubmitWebhook).mockResolvedValue(true);
  });

  it('executeSubmitTransportLead rejects invalid args', async () => {
    const { executeSubmitTransportLead } = await import('./execute-submit.js');
    const r = await executeSubmitTransportLead('c1', { itemId: '', clientName: '' }, null);
    expect(r.ok).toBe(false);
    expect(r.persisted).toBe(false);
  });

  it('executeSubmitTransportLead uses capturedPhone when tool omits phone', async () => {
    const { saveSession } = await import('../../infrastructure/storage/repository.js');
    saveSession('c-cap', 'LLM', {
      itemId: '',
      clientName: 'Юра',
      cargo: '',
      route: '',
      paymentMethod: '',
      phone: '+79001112233',
      capturedPhone: '+79001112233',
      chatMode: 'survey',
      llmMessages: [],
    });
    const { executeSubmitTransportLead } = await import('./execute-submit.js');
    const r = await executeSubmitTransportLead(
      'c-cap',
      { itemId: '', clientName: 'Юра' },
      {
        cargo: 'песок',
        route: 'А — Б',
        weight: '2 т',
        volume: '5 м3',
        payment_method: 'нал',
        phone: '',
      },
    );
    expect(r.ok).toBe(true);
    const { getClientByChatId } = await import('../../infrastructure/storage/repository.js');
    expect(getClientByChatId('c-cap')?.phone).toBe('+79001112233');
    expect(getClientByChatId('c-cap')?.cargo).toBe('песок');
  });

  it('executeSubmitTransportLead persists full lead', async () => {
    const { executeSubmitTransportLead } = await import('./execute-submit.js');
    const r = await executeSubmitTransportLead(
      'c-lead',
      { itemId: 'it', clientName: 'Мария' },
      {
        cargo: 'груз',
        route: 'X — Y',
        weight: '1 т',
        volume: '4 м3',
        payment_method: 'нал',
        phone: '+79031234567',
      },
    );
    expect(r.ok).toBe(true);
    expect(r.persisted).toBe(true);
    const { getClientByChatId } = await import('../../infrastructure/storage/repository.js');
    expect(getClientByChatId('c-lead')?.phone).toBe('+79031234567');
  });

  it('executeSubmitChatEstimateRequest persists without phone', async () => {
    saveSession('c-est', 'LLM', {
      itemId: 'it2',
      clientName: 'Олег',
      cargo: '',
      route: '',
      paymentMethod: '',
      phone: '',
      chatMode: 'survey_estimate_only',
      llmMessages: [{ role: 'user', content: 'Все загрузят и выгрузят за 5 точек, 93км.' }],
    });
    const { executeSubmitChatEstimateRequest } = await import('./execute-submit.js');
    const r = await executeSubmitChatEstimateRequest(
      'c-est',
      { itemId: 'it2', clientName: 'Олег' },
      {
        cargo: 'тент',
        route: 'М — СПб',
        weight: '1500 кг',
        volume: '12 м3',
        payment_method: 'безнал',
        details: '  важно  ',
      },
    );
    expect(r.ok).toBe(true);
    const { getChatEstimates, getClientByChatId } = await import(
      '../../infrastructure/storage/repository.js'
    );
    expect(getClientByChatId('c-est')).toBeNull();
    const row = getChatEstimates().find((e) => e.chatId === 'c-est');
    expect(row).toBeTruthy();
    expect(row?.details).toContain('важно');
    expect(row?.details).toContain('Полный текст клиента:');
    expect(row?.details).toContain('Все загрузят и выгрузят за 5 точек, 93км.');
  });

  it('executeSubmitChatEstimateRequest persists when volume is missing', async () => {
    const { executeSubmitChatEstimateRequest } = await import('./execute-submit.js');
    const r = await executeSubmitChatEstimateRequest(
      'c-est-no-volume',
      { itemId: 'it3', clientName: 'Олег' },
      {
        cargo: 'стекло',
        route: 'СПб — Москва',
        weight: '2 тонны',
        payment_method: 'наличные',
      },
    );
    expect(r.ok).toBe(true);
    const { getChatEstimates } = await import('../../infrastructure/storage/repository.js');
    const row = getChatEstimates().find((e) => e.chatId === 'c-est-no-volume');
    expect(row).toBeTruthy();
    expect(row?.volume).toBe('Не указан');
  });

  it('executeSubmitChatEstimateRequest rejects missing fields', async () => {
    const { executeSubmitChatEstimateRequest } = await import('./execute-submit.js');
    const r = await executeSubmitChatEstimateRequest(
      'c2',
      { itemId: '', clientName: '' },
      { cargo: '', route: 'a', weight: '', volume: '', payment_method: 'b' },
    );
    expect(r.ok).toBe(false);
  });

  it('executeSubmitPhoneBackfill updates clients', async () => {
    saveClient({
      chatId: 'c-phone',
      itemId: '',
      clientName: '',
      cargo: 'a',
      route: 'b',
      paymentMethod: 'c',
      phone: '',
    });
    const { executeSubmitPhoneBackfill } = await import('./execute-submit.js');
    const r = await executeSubmitPhoneBackfill('c-phone', { phone: '89035551122' });
    expect(r.ok).toBe(true);
    const { getClientByChatId } = await import('../../infrastructure/storage/repository.js');
    expect(getClientByChatId('c-phone')?.phone).toBe('+79035551122');
  });

  it('executeSubmitPhoneBackfill fails when no row', async () => {
    const { executeSubmitPhoneBackfill } = await import('./execute-submit.js');
    const r = await executeSubmitPhoneBackfill('missing', { phone: '+79001112233' });
    expect(r.ok).toBe(false);
  });

  it('executeSubmitPhoneBackfill creates clients row from chat-estimate context', async () => {
    upsertChatEstimateRequest({
      chatId: 'c-from-estimate',
      itemId: 'it-1',
      clientName: 'Клиент',
      cargo: 'стекло',
      weight: '2 т',
      volume: '3 м3',
      route: 'мск-спб',
      paymentMethod: 'безнал',
      details: 'хрупкий груз',
    });
    const { executeSubmitPhoneBackfill } = await import('./execute-submit.js');
    const r = await executeSubmitPhoneBackfill('c-from-estimate', { phone: '89001112233' });
    expect(r.ok).toBe(true);
    const { getClientByChatId } = await import('../../infrastructure/storage/repository.js');
    expect(getClientByChatId('c-from-estimate')?.phone).toBe('+79001112233');
  });

  it('executeDeclarePhoneContactPath sets survey', async () => {
    saveSession('c-path', 'LLM', {
      itemId: '',
      clientName: 'Тест',
      cargo: '',
      route: '',
      paymentMethod: '',
      phone: '',
      chatMode: 'phone_intent',
      llmMessages: [],
    });
    const { executeDeclarePhoneContactPath } = await import('./execute-submit.js');
    const r = await executeDeclarePhoneContactPath('c-path', { willing_to_share_phone: true });
    expect(r.ok).toBe(true);
    expect(getSession('c-path')?.data.chatMode).toBe('survey');
  });

  it('executeDeclarePhoneContactPath sets survey_estimate_only', async () => {
    saveSession('c-path2', 'LLM', {
      itemId: '',
      clientName: '',
      cargo: '',
      route: '',
      paymentMethod: '',
      phone: '',
      chatMode: 'phone_intent',
      llmMessages: [],
    });
    const { executeDeclarePhoneContactPath } = await import('./execute-submit.js');
    const r = await executeDeclarePhoneContactPath('c-path2', { willing_to_share_phone: false });
    expect(r.ok).toBe(true);
    expect(getSession('c-path2')?.data.chatMode).toBe('survey_estimate_only');
  });

  it('executeDeclarePhoneContactPath rejects missing session', async () => {
    const { executeDeclarePhoneContactPath } = await import('./execute-submit.js');
    const r = await executeDeclarePhoneContactPath('no-session', { willing_to_share_phone: true });
    expect(r.ok).toBe(false);
  });
});
