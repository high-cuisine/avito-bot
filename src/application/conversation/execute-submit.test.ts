import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDatabaseForTests,
  getSession,
  saveClient,
  saveSession,
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
    const { executeSubmitChatEstimateRequest } = await import('./execute-submit.js');
    const r = await executeSubmitChatEstimateRequest(
      'c-est',
      { itemId: 'it2', clientName: 'Олег' },
      { cargo: 'тент', route: 'М — СПб', payment_method: 'безнал', details: '  важно  ' },
    );
    expect(r.ok).toBe(true);
    const { getChatEstimates, getClientByChatId } = await import(
      '../../infrastructure/storage/repository.js'
    );
    expect(getClientByChatId('c-est')).toBeNull();
    expect(getChatEstimates().some((e) => e.chatId === 'c-est')).toBe(true);
  });

  it('executeSubmitChatEstimateRequest rejects missing fields', async () => {
    const { executeSubmitChatEstimateRequest } = await import('./execute-submit.js');
    const r = await executeSubmitChatEstimateRequest(
      'c2',
      { itemId: '', clientName: '' },
      { cargo: '', route: 'a', payment_method: 'b' },
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
