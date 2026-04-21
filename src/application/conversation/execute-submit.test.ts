import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDatabaseForTests, saveClient } from '../../infrastructure/storage/repository.js';

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
});
