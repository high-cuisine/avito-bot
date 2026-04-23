import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDatabaseForTests,
  getClientByChatId,
  getSession,
  saveClient,
  saveSession,
  type SessionData,
} from '../../infrastructure/storage/repository.js';

const runLlmTurn = vi.hoisted(() => vi.fn());
const classifyPriceReaction = vi.hoisted(() => vi.fn());
const postSubmitWebhook = vi.hoisted(() => vi.fn().mockResolvedValue(true));
const resolveUserId = vi.hoisted(() => vi.fn().mockResolvedValue('bot'));
const getChatById = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    users: [
      { id: 'bot', name: 'Bot' },
      { id: 'u1', name: 'Клиент' },
    ],
    context: { value: { id: 'it-1' } },
  }),
);

vi.mock('../../integrations/openai/chat.js', () => ({
  runLlmTurn,
  classifyPriceReaction,
}));
vi.mock('../../integrations/webhook/submit-lead.js', () => ({
  postSubmitWebhook,
}));
vi.mock('../../integrations/avito/client.js', () => ({
  resolveUserId,
  getChatById,
}));

const LLM_DATA_BASE: SessionData = {
  itemId: 'it-1',
  clientName: 'Клиент',
  cargo: '',
  route: '',
  paymentMethod: '',
  phone: '',
  llmMessages: [],
};

describe('conversation service templates', () => {
  beforeEach(() => {
    clearDatabaseForTests();
    runLlmTurn.mockReset();
    classifyPriceReaction.mockReset();
    postSubmitWebhook.mockReset();
    postSubmitWebhook.mockResolvedValue(true);
  });

  it('uses strict opening and phone-only thank you', async () => {
    const { handleConversation } = await import('./service.js');
    const opening = await handleConversation('ch-1', 'привет');
    expect(opening).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с вами.');

    const thanks = await handleConversation('ch-1', '+79000000000');
    expect(thanks).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
    expect(getSession('ch-1')).toBeNull();
  });

  it('answers callback-hours after phone-only completion', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-hours', 'привет');
    await handleConversation('ch-hours', '+79000000000');

    const hours = await handleConversation('ch-hours', 'когда перезвоните?');
    expect(hours).toBe('Мы работаем в будни с 8-00 до 18-00 по Москве.');
  });

  it('does not replay opening when client already has phone', async () => {
    saveClient({
      chatId: 'ch-engaged',
      itemId: 'it-1',
      clientName: 'Клиент',
      cargo: 'коробки',
      route: 'A-B',
      paymentMethod: 'наличные',
      phone: '+79000000001',
    });
    runLlmTurn.mockResolvedValueOnce({
      reply: 'Свободный ответ LLM',
      newHistoryEntries: [{ role: 'assistant', content: 'Свободный ответ LLM' }],
      sessionEnded: false,
    });
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-engaged', 'Расскажите подробнее');
    expect(reply).toBe('Свободный ответ LLM');
  });

  it('post-quote positive -> phone prompt -> thanks -> hours', async () => {
    saveClient({
      chatId: 'ch-pq',
      itemId: 'it-1',
      clientName: 'Клиент',
      cargo: 'a',
      route: 'b',
      paymentMethod: 'c',
      phone: '',
    });
    saveSession('ch-pq', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'post_quote',
      postQuotePhase: 'awaiting_sentiment',
    });
    classifyPriceReaction.mockResolvedValueOnce('positive');

    const { handleConversation } = await import('./service.js');
    const askPhone = await handleConversation('ch-pq', 'меня устраивает');
    expect(askPhone).toBe(
      'Напишите свой номер телефона, чтоб обсудить детали с логистом, кто занимается вашим направлением.',
    );
    expect(getSession('ch-pq')?.data.postQuotePhase).toBe('awaiting_phone');

    const thanks = await handleConversation('ch-pq', '8 (900) 123-45-67');
    expect(thanks).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
    expect(getClientByChatId('ch-pq')?.phone).toBe('+79001234567');

    const hours = await handleConversation('ch-pq', 'когда перезвоните');
    expect(hours).toBe('Мы работаем в будни с 8:00 до 18:00 по Москве.');
  });

  it('post-quote negative returns fixed budget phrase', async () => {
    saveClient({
      chatId: 'ch-neg',
      itemId: 'it-1',
      clientName: 'Клиент',
      cargo: 'a',
      route: 'b',
      paymentMethod: 'c',
      phone: '',
    });
    saveSession('ch-neg', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'post_quote',
      postQuotePhase: 'awaiting_sentiment',
    });
    classifyPriceReaction.mockResolvedValueOnce('negative');

    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-neg', 'дорого');
    expect(reply).toBe('Очень жаль, если у вас поменяется бюджет мы готовы вам помочь. Спасибо.');
    expect(getSession('ch-neg')?.data.chatMode).toBe('phone_backfill');
  });
});
