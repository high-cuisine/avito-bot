import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDatabaseForTests,
  getClientByChatId,
  getSession,
  upsertChatEstimateRequest,
} from '../../infrastructure/storage/repository.js';

const sendMessage = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock('../../integrations/avito/client.js', () => ({
  sendMessage,
}));

describe('deliverQuoteFromChatEstimateId', () => {
  beforeEach(() => {
    clearDatabaseForTests();
    sendMessage.mockClear();
  });

  it('returns 400 without price', async () => {
    const { deliverQuoteFromChatEstimateId } = await import('./deliver-chat-quote.js');
    const r = await deliverQuoteFromChatEstimateId(1, {});
    expect(r.status).toBe(400);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('returns 404 for unknown estimate id', async () => {
    const { deliverQuoteFromChatEstimateId } = await import('./deliver-chat-quote.js');
    const r = await deliverQuoteFromChatEstimateId(999, { price: '10 000 ₽' });
    expect(r.status).toBe(404);
  });

  it('returns 409 when client already has phone', async () => {
    const { saveClient } = await import('../../infrastructure/storage/repository.js');
    upsertChatEstimateRequest({
      chatId: 'ch409',
      itemId: '',
      clientName: '',
      cargo: 'a',
      weight: '1 кг',
      volume: '1 м3',
      route: 'b',
      paymentMethod: 'c',
      details: null,
    });
    const id = (await import('../../infrastructure/storage/repository.js')).getChatEstimates()[0]!.id;
    saveClient({
      chatId: 'ch409',
      itemId: '',
      clientName: '',
      cargo: 'a',
      route: 'b',
      paymentMethod: 'c',
      phone: '+79000000000',
    });
    const { deliverQuoteFromChatEstimateId } = await import('./deliver-chat-quote.js');
    const r = await deliverQuoteFromChatEstimateId(id, { price: '1' });
    expect(r.status).toBe(409);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends message and keeps data only in chat-estimates until phone', async () => {
    upsertChatEstimateRequest({
      chatId: 'ch-ok',
      itemId: 'it99',
      clientName: 'Анна',
      cargo: 'кирпич',
      weight: '2 т',
      volume: '3 м3',
      route: 'Воронеж — Рязань',
      paymentMethod: 'НДС',
      details: '2 т',
    });
    const { getChatEstimates } = await import('../../infrastructure/storage/repository.js');
    const id = getChatEstimates()[0]!.id;

    const { deliverQuoteFromChatEstimateId } = await import('./deliver-chat-quote.js');
    const r = await deliverQuoteFromChatEstimateId(id, { price: 125000 });

    expect(r.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith('ch-ok', expect.stringContaining('125000'));
    expect(sendMessage).not.toHaveBeenCalledWith('ch-ok', expect.stringContaining('номер телефона'));
    const client = getClientByChatId('ch-ok');
    expect(client).toBeNull();
    const session = getSession('ch-ok');
    expect(session?.data.chatMode).toBe('post_quote');
    expect(session?.data.postQuotePhase).toBe('awaiting_sentiment');
  });

  it('returns 502 when Avito send fails', async () => {
    sendMessage.mockRejectedValueOnce(new Error('Avito API 403'));
    upsertChatEstimateRequest({
      chatId: 'ch-fail',
      itemId: '',
      clientName: '',
      cargo: 'a',
      weight: '1 кг',
      volume: '1 м3',
      route: 'b',
      paymentMethod: 'c',
      details: null,
    });
    const { getChatEstimates } = await import('../../infrastructure/storage/repository.js');
    const id = getChatEstimates()[0]!.id;
    const { deliverQuoteFromChatEstimateId } = await import('./deliver-chat-quote.js');
    const r = await deliverQuoteFromChatEstimateId(id, { price: '1 ₽' });
    expect(r.status).toBe(502);
    expect(getClientByChatId('ch-fail')).toBeNull();
  });
});
