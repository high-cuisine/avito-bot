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

const ESTIMATE_ONLY_PROMPT =
  'Хорошо, считаем в чате без номера. Напишите, пожалуйста: \n' +
  '1.Маршрут (откуда куда везем)\n' +
  '2.Характер груз\n' +
  '3.Вес\n' +
  '4.Объем\n' +
  '5.Форму оплаты(наличные,безнал б/ндс, безнал с НДС)\n' +
  '6.Сколько примерно в метрах займет Ваш груз в кузове у нас по длине пола(при ширине кузова 2.4 метра)';

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
    expect(opening).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');

    const thanks = await handleConversation('ch-1', '+79000000000');
    expect(thanks).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
    expect(getSession('ch-1')).toBeNull();
  });

  it('answers callback-hours after phone-only completion', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-hours', 'привет');
    await handleConversation('ch-hours', '+79000000000');

    const hours = await handleConversation('ch-hours', 'когда перезвоните?');
    expect(hours).toBe('Мы работаем в будни с 9-00 до 18-00 по Москве.');
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
    expect(hours).toBe('Мы работаем в будни с 9:00 до 18:00 по Москве.');
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
    const { handleConversation } = await import('./service.js');

    await handleConversation('ch-refuse', 'привет');
    const reply = await handleConversation('ch-refuse', 'не хочу оставлять номер телефона');

    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
    expect(runLlmTurn).not.toHaveBeenCalled();
    expect(getSession('ch-refuse')?.data.chatMode).toBe('survey_estimate_only');
  });

  it('switches to estimate-only mode on any non-phone text after phone prompt', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-any-non-phone', 'привет');
    const reply = await handleConversation('ch-any-non-phone', 'давайте обсудим тут');
    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
    expect(runLlmTurn).not.toHaveBeenCalled();
    expect(getSession('ch-any-non-phone')?.data.chatMode).toBe('survey_estimate_only');
  });

  it('switches to estimate-only mode on price-first request in phone_intent', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-price-first', 'привет');
    const reply = await handleConversation('ch-price-first', 'посчитайте цену сначала мне');
    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
    expect(runLlmTurn).not.toHaveBeenCalled();
  });

  it('switches to estimate-only mode on "второй вариант"', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-second-option', 'привет');
    const reply = await handleConversation('ch-second-option', 'второй вариант');
    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
    expect(runLlmTurn).not.toHaveBeenCalled();
  });

  it('switches to estimate-only mode on broad refusal phrasing', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-broad-refuse', 'привет');
    const reply = await handleConversation('ch-broad-refuse', 'я не готов оставлять телефон, считаем в чате');
    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
    expect(runLlmTurn).not.toHaveBeenCalled();
  });

  it('does not spam estimate-only prompt after it was already sent', async () => {
    runLlmTurn.mockResolvedValueOnce({
      reply: 'Уточните, пожалуйста, вес груза и форму оплаты.',
      newHistoryEntries: [{ role: 'assistant', content: 'Уточните, пожалуйста, вес груза и форму оплаты.' }],
      sessionEnded: false,
    });
    saveSession('ch-est-no-phone', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'survey_estimate_only',
      llmMessages: [{ role: 'assistant', content: ESTIMATE_ONLY_PROMPT }],
    });
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-est-no-phone', 'маршрут спб москва');
    expect(reply).toBe('Уточните, пожалуйста, вес груза и форму оплаты.');
    expect(runLlmTurn).toHaveBeenCalledOnce();
  });

  it('strips markdown stars from estimate-only follow-up text', async () => {
    runLlmTurn.mockResolvedValueOnce({
      reply:
        '1. **Характер груза**\n2. **Объем**\n3. **Форма оплаты**\n4. **Длина по полу**',
      newHistoryEntries: [
        {
          role: 'assistant',
          content:
            '1. **Характер груза**\n2. **Объем**\n3. **Форма оплаты**\n4. **Длина по полу**',
        },
      ],
      sessionEnded: false,
    });
    saveSession('ch-est-stars', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'survey_estimate_only',
      llmMessages: [{ role: 'assistant', content: ESTIMATE_ONLY_PROMPT }],
    });
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-est-stars', 'Маршрут: Москва - Санкт-Петербург\nВес: 2 тонны');
    expect(reply).toBe('1. Характер груза\n2. Объем\n3. Форма оплаты\n4. Длина по полу');
  });

  it('switches survey mode to estimate-only on short refusal "не дам"', async () => {
    saveSession('ch-survey-refuse', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'survey',
      llmMessages: [{ role: 'assistant', content: 'Укажите, пожалуйста, номер телефона.' }],
    });

    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-survey-refuse', 'не дам');

    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
    expect(runLlmTurn).not.toHaveBeenCalled();
    expect(getSession('ch-survey-refuse')?.data.chatMode).toBe('survey_estimate_only');
  });

  it('switches survey mode to estimate-only on any non-phone message', async () => {
    saveSession('ch-survey-any', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'survey',
      llmMessages: [{ role: 'assistant', content: 'Пришлите номер телефона.' }],
    });

    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-survey-any', 'маршрут москва казань');

    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
    expect(runLlmTurn).not.toHaveBeenCalled();
    expect(getSession('ch-survey-any')?.data.chatMode).toBe('survey_estimate_only');
  });

  it('returns fixed estimate-only questionnaire when mode starts without assistant history', async () => {
    saveSession('ch-est-empty-history', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'survey_estimate_only',
      llmMessages: [],
    });

    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-est-empty-history', 'нужен расчет');

    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
    expect(runLlmTurn).not.toHaveBeenCalled();
  });

  it('completes with thanks when phone arrives in survey mode', async () => {
    saveSession('ch-survey-phone', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'survey',
      llmMessages: [{ role: 'assistant', content: 'Пришлите номер телефона.' }],
    });

    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-survey-phone', 'мой телефон 8 (900) 000-00-02');

    expect(reply).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
    expect(runLlmTurn).not.toHaveBeenCalled();
    expect(getSession('ch-survey-phone')).toBeNull();
    expect(getClientByChatId('ch-survey-phone')?.phone).toBe('+79000000002');
  });
});
