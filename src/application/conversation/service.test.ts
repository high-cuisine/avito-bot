import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const classifyClosingMessage = vi.hoisted(() => vi.fn());
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
  classifyClosingMessage,
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
    vi.useFakeTimers();
    // 2026-05-04 12:00:00 UTC => 15:00 МСК (будний день, рабочее время)
    vi.setSystemTime(new Date('2026-05-04T12:00:00.000Z'));
    clearDatabaseForTests();
    runLlmTurn.mockReset();
    classifyPriceReaction.mockReset();
    classifyClosingMessage.mockReset();
    classifyClosingMessage.mockImplementation(async (text: string) =>
      /(спасибо|договорились|ждем|ждём|ок|окей|понял|понятно)/i.test(text),
    );
    postSubmitWebhook.mockReset();
    postSubmitWebhook.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses strict opening and phone-only thank you', async () => {
    const { handleConversation } = await import('./service.js');
    const opening = await handleConversation('ch-1', 'привет');
    expect(opening).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');

    const thanks = await handleConversation('ch-1', '+79000000000');
    expect(thanks).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
    expect(getSession('ch-1')?.data.chatMode).toBe('engaged');
  });

  it('accepts phone from the very first message', async () => {
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-first-phone', 'добрый день, мой номер 8 (900) 555-44-33');
    expect(reply).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
    expect(getSession('ch-first-phone')?.data.chatMode).toBe('engaged');
    expect(getClientByChatId('ch-first-phone')?.phone).toBe('+79005554433');
  });

  it('answers callback-hours after phone-only completion', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-hours', 'привет');
    await handleConversation('ch-hours', '+79000000000');

    const hours = await handleConversation('ch-hours', 'когда перезвоните?');
    expect(hours).toBe('Мы работаем в будни с 9-00 до 18-00 по Москве.');
  });

  it('does not answer callback-hours on "ждем" after phone-only completion', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-wait', 'привет');
    await handleConversation('ch-wait', '+79000000000');

    const reply = await handleConversation('ch-wait', 'ждем');
    expect(reply).toBe('👍');
  });

  it('does not answer callback-hours on "спасибо" after phone-only completion', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-thanks-msg', 'привет');
    await handleConversation('ch-thanks-msg', '+79000000000');

    const reply = await handleConversation('ch-thanks-msg', 'спасибо');
    expect(reply).toBe('👍');
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
    expect(reply).toBe('Спасибо за сообщение. Уточните, пожалуйста, ваш вопрос.');
  });

  it('replies politely without pushing new order on gratitude in engaged mode', async () => {
    saveClient({
      chatId: 'ch-engaged-thanks',
      itemId: 'it-1',
      clientName: 'Клиент',
      cargo: 'коробки',
      route: 'A-B',
      paymentMethod: 'наличные',
      phone: '+79000000001',
    });
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-engaged-thanks', 'спасибо');
    expect(reply).toBe('👍');
  });

  it('starts with phone request even if chat-estimate exists', async () => {
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
    expect(reply).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');
    expect(getSession('ch-est-wait')?.data.chatMode).toBe('phone_intent');
  });

  it('estimate-wait thanks reply is friendly', async () => {
    saveSession('ch-est-wait-thanks', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'estimate_wait',
      llmMessages: [{ role: 'assistant', content: 'Расчет в работе.' }],
    });
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-est-wait-thanks', 'хорошо спасибо');
    expect(reply).toBe('👍');
  });

  it('accepts phone in estimate_wait mode and thanks', async () => {
    saveSession('ch-est-wait-phone', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'estimate_wait',
      llmMessages: [{ role: 'assistant', content: 'Расчет в работе.' }],
    });
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-est-wait-phone', 'давайте по номеру 89658824885');
    expect(reply).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
    expect(getSession('ch-est-wait-phone')?.data.chatMode).toBe('engaged');
    expect(getClientByChatId('ch-est-wait-phone')?.phone).toBe('+79658824885');
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
    expect(getSession('ch-refuse')?.data.chatMode).toBe('survey_estimate_only');
  });

  it('switches to estimate-only mode on any non-phone text after phone prompt', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-any-non-phone', 'привет');
    const reply = await handleConversation('ch-any-non-phone', 'давайте обсудим тут');
    expect(reply).toBe('Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');
    expect(getSession('ch-any-non-phone')?.data.chatMode).toBe('phone_intent');
  });

  it('switches to estimate-only mode on short refusal "нет"', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-short-no', 'привет');
    const reply = await handleConversation('ch-short-no', 'нет');
    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
    expect(getSession('ch-short-no')?.data.chatMode).toBe('survey_estimate_only');
  });

  it('switches to estimate-only mode on short refusal "не хочу"', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-short-no-want', 'привет');
    const reply = await handleConversation('ch-short-no-want', 'не хочу');
    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
    expect(getSession('ch-short-no-want')?.data.chatMode).toBe('survey_estimate_only');
  });

  it('uses fixed estimate-only template when refusal has no transport data', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-refuse-no-data', 'привет');
    const reply = await handleConversation('ch-refuse-no-data', 'номер не дам, давайте считать тут');
    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
  });

  it('returns invalid phone message and waits for retry', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-invalid-phone', 'привет');
    const reply = await handleConversation('ch-invalid-phone', 'мой номер 8 999 111 22 33 44');
    expect(reply).toBe('Ваш номер указан не верно, просьба проверить цифры.');
    expect(getSession('ch-invalid-phone')?.data.chatMode).toBe('phone_intent');
  });

  it('accepts same invalid phone on repeated send', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-repeat-invalid-phone', 'привет');
    await handleConversation('ch-repeat-invalid-phone', 'мой номер 8 999 111 22 33 44');
    const thanks = await handleConversation('ch-repeat-invalid-phone', 'мой номер 8 999 111 22 33 44');
    expect(thanks).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
    expect(getSession('ch-repeat-invalid-phone')?.data.chatMode).toBe('engaged');
    expect(getClientByChatId('ch-repeat-invalid-phone')?.phone).toBe('мой номер 8 999 111 22 33 44');
  });

  it('switches to estimate-only mode on price-first request in phone_intent', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-price-first', 'привет');
    const reply = await handleConversation('ch-price-first', 'посчитайте цену сначала мне');
    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
  });

  it('switches to estimate-only mode on "посчитайте стоимость" in first message', async () => {
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation(
      'ch-first-price',
      'добрый день\nпосчитайте стоимость\nмск спб\nстекло\n2 тонны',
    );
    expect(reply).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');
  });

  it('asks only missing estimate fields from previously sent data after phone refusal', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation(
      'ch-first-partial-estimate',
      'добрый день\nпосчитайте стоимость\nмск спб\nстекло\n2 тонны',
    );
    const reply = await handleConversation('ch-first-partial-estimate', 'номер не дам');
    expect(reply).toContain('Для расчета в чате без номера уточните, пожалуйста:');
    expect(reply).toContain('объем');
    expect(reply).toContain('форму оплаты');
    expect(reply).toContain('сколько метров по длине пола займет груз в кузове');
    expect(reply).not.toContain('маршрут');
    expect(reply).not.toContain('характер груза');
    expect(reply).not.toContain('вес');
  });

  it('detects route and cargo from multi-load/multi-line noisy text', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation(
      'ch-multiload',
      'загрузка\n1) аксайский проспект 19А даска 45*145*4м - 11шт\n2) ул. Днепропетровская 52а брус 45*45*3 - 27шт\nвыгрузка\nул. Изумрудная 9',
    );
    const reply = await handleConversation('ch-multiload', 'все детали выше');
    expect(reply).toContain('вес');
    expect(reply).toContain('объем');
    expect(reply).toContain('форму оплаты');
    expect(reply).toContain('сколько метров по длине пола займет груз в кузове');
    expect(reply).not.toContain('маршрут');
    expect(reply).not.toContain('характер груза');
  });

  it('switches to estimate-only on short "расчитайте" after phone prompt and uses prior data', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation(
      'ch-short-calc-request',
      'добрый день, нужна перевозка спб москва стекло 2 тонны 2 куба наличка',
    );
    const reply = await handleConversation('ch-short-calc-request', 'расчитайте');
    expect(reply).toContain('Для расчета в чате без номера уточните, пожалуйста:');
    expect(reply).toContain('сколько метров по длине пола займет груз в кузове');
    expect(reply).not.toContain('маршрут');
    expect(reply).not.toContain('характер груза');
    expect(reply).not.toContain('вес');
    expect(reply).not.toContain('объем');
    expect(reply).not.toContain('форму оплаты');
  });

  it('treats pallet count as volume and floor-length data', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation(
      'ch-pallets',
      'добрый день, нужна перевозка спб москва стекло 2 тонны наличка',
    );
    const first = await handleConversation('ch-pallets', 'детали все есть');
    expect(first).toContain('объем');
    expect(first).toContain('сколько метров по длине пола займет груз в кузове');

    runLlmTurn.mockResolvedValueOnce({
      reply: 'Принято, зафиксировал. Если все верно, передаю заявку на расчет.',
      newHistoryEntries: [{ role: 'assistant', content: 'Принято, зафиксировал. Если все верно, передаю заявку на расчет.' }],
      sessionEnded: false,
    });
    const second = await handleConversation('ch-pallets', '5 палетов');
    expect(second).toBe('Принято, зафиксировал. Если все верно, передаю заявку на расчет.');
    expect(second).not.toContain('объем');
    expect(second).not.toContain('сколько метров по длине пола займет груз в кузове');
  });

  it('overrides llm retry when pallets already provided', async () => {
    runLlmTurn.mockResolvedValueOnce({
      reply:
        'Пожалуйста, уточните ещё, какой объём занимает груз и сколько метров по длине пола в кузове он займёт?',
      newHistoryEntries: [
        {
          role: 'assistant',
          content:
            'Пожалуйста, уточните ещё, какой объём занимает груз и сколько метров по длине пола в кузове он займёт?',
        },
      ],
      sessionEnded: false,
    });
    saveSession('ch-pallet-override', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'survey_estimate_only',
      llmMessages: [
        { role: 'user', content: 'мск спб стекло' },
        { role: 'assistant', content: 'Принято. Для расчета в чате без номера уточните, пожалуйста: вес, объем, форму оплаты, сколько метров по длине пола займет груз в кузове.' },
      ],
    });
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-pallet-override', 'вес тонна суммарно\nналичка\n5 палетов');
    expect(reply).not.toContain('объём');
    expect(reply).not.toContain('по длине пола');
  });

  it('switches to estimate-only mode on "второй вариант"', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-second-option', 'привет');
    const reply = await handleConversation('ch-second-option', 'второй вариант');
    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
  });

  it('switches to estimate-only mode on broad refusal phrasing', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-broad-refuse', 'привет');
    const reply = await handleConversation('ch-broad-refuse', 'я не готов оставлять телефон, считаем в чате');
    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
  });

  it('switches to estimate-only mode on indirect refusal "детали все указаны"', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-indirect-refuse', 'привет');
    const reply = await handleConversation('ch-indirect-refuse', 'детали все указаны');
    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
  });

  it('switches to estimate-only mode on indirect refusal "детали все есть"', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-indirect-refuse-has', 'привет');
    const reply = await handleConversation('ch-indirect-refuse-has', 'детали все есть');
    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
  });

  it('switches to estimate-only mode on indirect refusal "все детали выше"', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('ch-indirect-refuse-above', 'привет');
    const reply = await handleConversation('ch-indirect-refuse-above', 'все детали выше');
    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
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

  it('does not reset to fixed estimate-only prompt after custom follow-up was sent', async () => {
    runLlmTurn.mockResolvedValueOnce({
      reply: 'Принято, данных достаточно. Уточните только точный объем в м3.',
      newHistoryEntries: [
        { role: 'assistant', content: 'Принято, данных достаточно. Уточните только точный объем в м3.' },
      ],
      sessionEnded: false,
    });
    saveSession('ch-est-custom-followup', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'survey_estimate_only',
      llmMessages: [{ role: 'assistant', content: 'Принято. Для расчета в чате без номера уточните, пожалуйста: объем.' }],
    });

    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-est-custom-followup', '5 палетов');
    expect(reply).toBe('Принято, данных достаточно. Уточните только точный объем в м3.');
    expect(reply).not.toBe(ESTIMATE_ONLY_PROMPT);
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
    expect(getSession('ch-survey-any')?.data.chatMode).toBe('survey_estimate_only');
  });

  it('accepts phone in survey_estimate_only mode and thanks', async () => {
    saveSession('ch-est-phone-late', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'survey_estimate_only',
      llmMessages: [{ role: 'assistant', content: ESTIMATE_ONLY_PROMPT }],
    });
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('ch-est-phone-late', 'давайте по телефону 89658824885');
    expect(reply).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
    expect(getSession('ch-est-phone-late')?.data.chatMode).toBe('engaged');
    expect(getClientByChatId('ch-est-phone-late')?.phone).toBe('+79658824885');
  });

  it('keeps estimate-wait after chat-estimate submit and replies dry on thanks', async () => {
    runLlmTurn.mockResolvedValueOnce({
      reply: 'Спасибо! Параметры для расчета сохранены. Как только расчет будет готов, мы ответим в этом чате.',
      newHistoryEntries: [
        {
          role: 'assistant',
          content:
            'Спасибо! Параметры для расчета сохранены. Как только расчет будет готов, мы ответим в этом чате.',
        },
      ],
      sessionEnded: true,
    });
    saveSession('ch-est-done-thanks', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'survey_estimate_only',
      llmMessages: [{ role: 'assistant', content: ESTIMATE_ONLY_PROMPT }],
    });
    const { handleConversation } = await import('./service.js');
    const done = await handleConversation('ch-est-done-thanks', 'да, европалеты');
    expect(done).toBe(
      'Спасибо! Параметры для расчета сохранены. Как только расчет будет готов, мы ответим в этом чате.',
    );
    expect(getSession('ch-est-done-thanks')?.data.chatMode).toBe('estimate_wait');

    const thanks = await handleConversation('ch-est-done-thanks', 'хорошо спасибо');
    expect(thanks).toBe('👍');
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
    expect(getSession('ch-survey-phone')?.data.chatMode).toBe('engaged');
    expect(getClientByChatId('ch-survey-phone')?.phone).toBe('+79000000002');
  });

  it('scenario: phone-first -> refusal without data -> always fixed template', async () => {
    const { handleConversation } = await import('./service.js');

    const step1 = await handleConversation('ch-scn-fixed-template', 'добрый день');
    expect(step1).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');

    const step2 = await handleConversation('ch-scn-fixed-template', 'номер не дам, считаем здесь');
    expect(step2).toBe(ESTIMATE_ONLY_PROMPT);

    // no transport data yet -> still fixed template
    const step3 = await handleConversation('ch-scn-fixed-template', 'все детали выше');
    expect(step3).toBe(ESTIMATE_ONLY_PROMPT);
  });

  it('scenario: phone-first -> refusal with data -> asks only missing fields', async () => {
    const { handleConversation } = await import('./service.js');

    await handleConversation('ch-scn-missing-only', 'добрый день');
    const reply = await handleConversation(
      'ch-scn-missing-only',
      'номер не дам, считаем тут: мск спб, стекло, 2 тонны',
    );

    expect(reply).toContain('Для расчета в чате без номера уточните, пожалуйста:');
    expect(reply).toContain('объем');
    expect(reply).toContain('форму оплаты');
    expect(reply).toContain('сколько метров по длине пола займет груз в кузове');
    expect(reply).not.toContain('маршрут');
    expect(reply).not.toContain('характер груза');
    expect(reply).not.toContain('вес');
  });

  it('scenario: estimate-only -> late phone -> engaged -> closing message gets empty reply', async () => {
    const { handleConversation } = await import('./service.js');

    await handleConversation('ch-scn-late-phone', 'привет');
    await handleConversation('ch-scn-late-phone', 'номер не дам');
    const thanks = await handleConversation('ch-scn-late-phone', 'тогда давайте по номеру 8 (965) 882-48-85');

    expect(thanks).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
    expect(getSession('ch-scn-late-phone')?.data.chatMode).toBe('engaged');

    const closing = await handleConversation('ch-scn-late-phone', 'спасибо');
    expect(closing).toBe('👍');
  });
});
