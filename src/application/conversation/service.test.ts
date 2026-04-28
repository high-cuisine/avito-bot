import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDatabaseForTests,
  getClientByChatId,
  getSession,
  saveClient,
  saveSession,
  upsertChatEstimateRequest,
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

  it('asks clarifying question when client with saved phone writes again', async () => {
    saveClient({
      chatId: 'ch-engaged',
      itemId: 'it-1',
      clientName: 'Клиент',
      cargo: 'коробки',
      route: 'A-B',
      paymentMethod: 'наличные',
      phone: '+79000000001',
    });
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-engaged', 'Расскажите подробнее');
    expect(reply).toBe(
      'Спасибо за сообщение. Уточните, пожалуйста, ваш вопрос. Если хотите оформить новую перевозку, напишите маршрут, груз и вес.',
    );
  });

  it('keeps estimate-wait context after restart and replies with waiting message', async () => {
    upsertChatEstimateRequest({
      chatId: 'ch-est-wait',
      itemId: 'it-2',
      clientName: 'Клиент',
      cargo: 'металл',
      weight: '2 тонны',
      volume: 'Не указан',
      route: 'Ижевск — Воткинск',
      paymentMethod: 'наличные',
      details: null,
    });
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-est-wait', 'Ждем расчет');
    expect(reply).toBe(
      'Ожидайте, пожалуйста: как только расчет цены будет готов, мы сразу ответим вам в этом чате.',
    );
    expect(getSession('ch-est-wait')?.data.chatMode).toBe('estimate_wait');
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

  it('switches to estimate-only mode when client declines phone', async () => {
    runLlmTurn.mockResolvedValueOnce({
      reply: 'Хорошо, рассчитаем без телефона. Укажите маршрут и груз.',
      newHistoryEntries: [
        { role: 'assistant', content: 'Хорошо, рассчитаем без телефона. Укажите маршрут и груз.' },
      ],
      sessionEnded: false,
    });
    const { handleConversation } = await import('./service.js');

    await handleConversation('ch-refuse', 'привет');
    const reply = await handleConversation('ch-refuse', 'не хочу оставлять номер телефона');

    expect(reply).toBe('Хорошо, рассчитаем без телефона. Укажите маршрут и груз.');
    expect(runLlmTurn).toHaveBeenCalled();
    const lastCall = runLlmTurn.mock.calls.at(-1);
    expect(lastCall?.[2]?.chatMode).toBe('survey_estimate_only');
    expect(getSession('ch-refuse')?.data.chatMode).toBe('survey_estimate_only');
  });

  it('switches to estimate-only mode on price-first request in phone_intent', async () => {
    runLlmTurn.mockResolvedValueOnce({
      reply: 'Поняла, считаем без телефона. Укажите маршрут, груз, вес и оплату.',
      newHistoryEntries: [
        { role: 'assistant', content: 'Поняла, считаем без телефона. Укажите маршрут, груз, вес и оплату.' },
      ],
      sessionEnded: false,
    });
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-price-first', 'привет');
    const reply = await handleConversation('ch-price-first', 'посчитайте цену сначала мне');
    expect(reply).toBe('Поняла, считаем без телефона. Укажите маршрут, груз, вес и оплату.');
    const lastCall = runLlmTurn.mock.calls.at(-1);
    expect(lastCall?.[2]?.chatMode).toBe('survey_estimate_only');
  });

  it('switches survey mode to estimate-only on short refusal "не дам"', async () => {
    runLlmTurn.mockResolvedValueOnce({
      reply: 'Принято, посчитаем без номера. Уточните маршрут, груз, вес, объем и оплату.',
      newHistoryEntries: [
        {
          role: 'assistant',
          content: 'Принято, посчитаем без номера. Уточните маршрут, груз, вес, объем и оплату.',
        },
      ],
      sessionEnded: false,
    });
    saveSession('ch-survey-refuse', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'survey',
      llmMessages: [{ role: 'assistant', content: 'Укажите, пожалуйста, номер телефона.' }],
    });

    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-survey-refuse', 'не дам');

    expect(reply).toBe('Принято, посчитаем без номера. Уточните маршрут, груз, вес, объем и оплату.');
    const lastCall = runLlmTurn.mock.calls.at(-1);
    expect(lastCall?.[2]?.chatMode).toBe('survey_estimate_only');
    expect(getSession('ch-survey-refuse')?.data.chatMode).toBe('survey_estimate_only');
  });
});
