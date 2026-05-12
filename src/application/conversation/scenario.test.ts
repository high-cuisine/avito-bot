import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDatabaseForTests, getSession, saveSession, type SessionData } from '../../infrastructure/storage/repository.js';

const runLlmTurn = vi.hoisted(() => vi.fn());
const classifyPriceReaction = vi.hoisted(() => vi.fn());
const classifyClosingMessage = vi.hoisted(() => vi.fn());
const classifyEstimateFields = vi.hoisted(() => vi.fn());
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
  classifyEstimateFields,
}));
vi.mock('../../integrations/webhook/submit-lead.js', () => ({
  postSubmitWebhook,
}));
vi.mock('../../integrations/avito/client.js', () => ({
  resolveUserId,
  getChatById,
}));

const ESTIMATE_ONLY_PROMPT =
  'Хорошо, считаем в чате без номера. Напишите, пожалуйста: \n' +
  '1.Маршрут (откуда куда везем)\n' +
  '2.Характер груз\n' +
  '3.Вес\n' +
  '4.Объем\n' +
  '5.Форму оплаты(наличные,безнал б/ндс, безнал с НДС)\n' +
  '6.Сколько примерно в метрах займет Ваш груз в кузове у нас по длине пола(при ширине кузова 2.4 метра)';

const ESTIMATE_SAVED_REPLY =
  'Спасибо! Параметры для расчета сохранены. Как только расчет будет готов, мы ответим в этом чате.\n\n' +
  'И на всякий случай - если вдруг возникнут перебои со связью или сообщение не дойдёт вовремя, можем дублировать результат вам на телефон. Оставьте номер, если будет удобно - чтобы точно не потерять контакт.\n\n' +
  'Хорошего вам дня';

const LLM_DATA_BASE: SessionData = {
  itemId: 'it-1',
  clientName: 'Клиент',
  cargo: '',
  route: '',
  paymentMethod: '',
  phone: '',
  llmMessages: [],
};

describe('conversation scenarios from scenario-cases.md', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-04T12:00:00.000Z'));
    clearDatabaseForTests();
    runLlmTurn.mockReset();
    classifyPriceReaction.mockReset();
    classifyClosingMessage.mockReset();
    classifyClosingMessage.mockImplementation(async (text: string) =>
      /(спасибо|договорились|ждем|ждём|ок|окей|понял|понятно)/i.test(text),
    );
    classifyEstimateFields.mockReset();
    classifyEstimateFields.mockResolvedValue({
      route: false, cargo: false, weight: false, volume: false, payment: false, floorMeters: false,
    });
    postSubmitWebhook.mockReset();
    postSubmitWebhook.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scn-multiload-refusal-then-data', async () => {
    const { handleConversation } = await import('./service.js');

    const step1 = await handleConversation(
      'scn-multiload-refusal-then-data',
      [
        'доброго дня! Уточните пожалкйста, сейчас сможете за 4000-4500 руб собрать заказ?',
        '',
        'Все загрузят и выгрузят по минут на точке - 5 точек, 93км.',
        '',
        'загрузка',
        '!)аксайский проспект 19А Даска 45*145*4м - 11шт',
        '',
        '2) ул. Днепропетровская 52а',
        'Брус 45*45*3 - 27шт',
        '3) 3л мадояна 316 ст Ростов-зададный 145*45*6 - 16шт',
        '',
        'выгрузка',
        '5) ул. Изумрудная 9, пос Темерцикий, район Аксай',
      ].join('\n'),
    );
    expect(step1).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');

    classifyEstimateFields.mockResolvedValueOnce({
      route: true, cargo: true, weight: false, volume: false, payment: false, floorMeters: false,
    });
    const step2 = await handleConversation('scn-multiload-refusal-then-data', 'все детали выше');
    expect(step2).toBe(
      'Принято. Для расчета в чате без номера уточните, пожалуйста: вес, объем, форму оплаты, сколько метров по длине пола займет груз в кузове.',
    );

    runLlmTurn.mockResolvedValueOnce({
      reply: 'Принято. Уточните, пожалуйста, общий вес груза.',
      newHistoryEntries: [{ role: 'assistant', content: 'Принято. Уточните, пожалуйста, общий вес груза.' }],
      sessionEnded: false,
    });
    const step3 = await handleConversation('scn-multiload-refusal-then-data', 'тонна 5 палетов наличка 3 куба');
    expect(step3).toBe('Принято. Уточните, пожалуйста, общий вес груза.');
    expect(step3).not.toContain('По\nчто');
  });

  it('scn-first-message-phone', async () => {
    const { handleConversation } = await import('./service.js');

    const reply = await handleConversation('scn-first-message-phone', 'добрый день, 89658824885');
    expect(reply).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
    expect(getSession('scn-first-message-phone')?.data.chatMode).toBe('engaged');
  });

  it('scn-refusal-structured-pallets', async () => {
    const { handleConversation } = await import('./service.js');

    const step1 = await handleConversation('scn-refusal-structured-pallets', 'добрый день');
    expect(step1).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');

    const step2 = await handleConversation('scn-refusal-structured-pallets', 'не хочу');
    expect(step2).toBe(ESTIMATE_ONLY_PROMPT);

    runLlmTurn.mockResolvedValueOnce({
      reply: 'Принято. Для расчета в чате без номера уточните, пожалуйста: вес.',
      newHistoryEntries: [
        { role: 'assistant', content: 'Принято. Для расчета в чате без номера уточните, пожалуйста: вес.' },
      ],
      sessionEnded: false,
    });
    const step3 = await handleConversation('scn-refusal-structured-pallets', 'спб мск\n5 палетов\nналичка\nстекло');
    expect(step3).toBe('Принято. Для расчета в чате без номера уточните, пожалуйста: вес.');

    runLlmTurn.mockResolvedValueOnce({
      reply: 'Принято, передаю заявку на расчет.',
      newHistoryEntries: [{ role: 'assistant', content: 'Принято, передаю заявку на расчет.' }],
      sessionEnded: false,
    });
    const step4 = await handleConversation('scn-refusal-structured-pallets', '3 куба, 2 тонны');
    expect(step4).toBe('Принято, передаю заявку на расчет.');

    runLlmTurn.mockResolvedValueOnce({
      reply: ESTIMATE_SAVED_REPLY,
      newHistoryEntries: [
        {
          role: 'assistant',
          content: ESTIMATE_SAVED_REPLY,
        },
      ],
      sessionEnded: true,
    });
    const step5 = await handleConversation('scn-refusal-structured-pallets', 'нет');
    expect(step5).toBe(ESTIMATE_SAVED_REPLY);
    expect(getSession('scn-refusal-structured-pallets')?.data.chatMode).toBe('estimate_wait');
  });

  it('scn-template-on-greeting-with-cargo', async () => {
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation(
      'scn-template-on-greeting-with-cargo',
      'добрый день, мск спб, стекло, 2 тонны, 3 куба, наличка',
    );
    expect(reply).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');
  });

  it('scn-nonstandard-greeting-then-chat-choice', async () => {
    const { handleConversation } = await import('./service.js');

    const step1 = await handleConversation('scn-nonstandard-greeting', 'это тест.Приветствую');
    expect(step1).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');

    const step2 = await handleConversation('scn-nonstandard-greeting', 'давайте в чате');
    expect(step2).toBe(ESTIMATE_ONLY_PROMPT);
  });

  it('scn-refusal-without-data-keeps-template', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('scn-refusal-without-data-keeps-template', 'добрый день');
    const step2 = await handleConversation('scn-refusal-without-data-keeps-template', 'номер не дам');
    expect(step2).toBe(ESTIMATE_ONLY_PROMPT);
    const step3 = await handleConversation('scn-refusal-without-data-keeps-template', 'ок');
    expect(step3).toBe(ESTIMATE_ONLY_PROMPT);
  });

  it('scn-estimate-difficulty-offers-phone-call', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('scn-estimate-difficulty', 'добрый день');
    await handleConversation('scn-estimate-difficulty', 'номер не дам');
    runLlmTurn.mockClear();

    const reply = await handleConversation('scn-estimate-difficulty', 'не знаю как ответить на эти вопросы');

    expect(reply).toBe(
      'Если затрудняетесь ответить на вопросы по расчету, напишите свой номер телефона — свяжемся с Вами и проговорим все моменты.',
    );
    expect(runLlmTurn).not.toHaveBeenCalled();
    expect(getSession('scn-estimate-difficulty')?.data.chatMode).toBe('survey_estimate_only');
  });

  it('scn-partial-data-partition-followup', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('scn-partial-data-partition-followup', 'добрый день');
    await handleConversation('scn-partial-data-partition-followup', 'не хочу');

    runLlmTurn.mockResolvedValueOnce({
      reply: 'Принято. Для расчета в чате без номера уточните, пожалуйста: вес, объем, форму оплаты, сколько метров по длине пола займет груз в кузове.',
      newHistoryEntries: [
        {
          role: 'assistant',
          content:
            'Принято. Для расчета в чате без номера уточните, пожалуйста: вес, объем, форму оплаты, сколько метров по длине пола займет груз в кузове.',
        },
      ],
      sessionEnded: false,
    });
    const step3 = await handleConversation('scn-partial-data-partition-followup', 'спб мск, стекло');
    expect(step3).toBe(
      'Принято. Для расчета в чате без номера уточните, пожалуйста: вес, объем, форму оплаты, сколько метров по длине пола займет груз в кузове.',
    );

    runLlmTurn.mockResolvedValueOnce({
      reply: 'Принято. Для расчета в чате без номера уточните, пожалуйста: объем, форму оплаты, сколько метров по длине пола займет груз в кузове.',
      newHistoryEntries: [
        {
          role: 'assistant',
          content:
            'Принято. Для расчета в чате без номера уточните, пожалуйста: объем, форму оплаты, сколько метров по длине пола займет груз в кузове.',
        },
      ],
      sessionEnded: false,
    });
    const step4 = await handleConversation('scn-partial-data-partition-followup', '2 тонны');
    expect(step4).toBe(
      'Принято. Для расчета в чате без номера уточните, пожалуйста: объем, форму оплаты, сколько метров по длине пола займет груз в кузове.',
    );
  });

  it('scn-late-phone-accepted-and-closing-silent', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('scn-late-phone-accepted-and-closing-silent', 'добрый день');
    await handleConversation('scn-late-phone-accepted-and-closing-silent', 'не хочу');

    const phoneAccepted = await handleConversation(
      'scn-late-phone-accepted-and-closing-silent',
      'давайте по номеру 89658824885',
    );
    expect(phoneAccepted).toBe('Спасибо, мы перезвоним вам в ближайшее время.');

    const closing1 = await handleConversation('scn-late-phone-accepted-and-closing-silent', 'договорились');
    const closing2 = await handleConversation('scn-late-phone-accepted-and-closing-silent', 'спасибо');
    expect(closing1).toBe('👍');
    expect(closing2).toBe('');
  });

  it('scn-template-on-greeting-only', async () => {
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('scn-greeting-only', 'добрый день');
    expect(reply).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');
  });

  it('scn-refusal-context-aware-followup', async () => {
    const { handleConversation } = await import('./service.js');

    const step1 = await handleConversation('scn-ctx-followup', 'добрый день, мск спб, стекло, 2 тонны');
    expect(step1).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');

    classifyEstimateFields.mockResolvedValueOnce({
      route: true, cargo: true, weight: true, volume: false, payment: false, floorMeters: false,
    });
    const step2 = await handleConversation('scn-ctx-followup', 'номер не дам');
    expect(step2).toContain('Принято. Для расчета в чате без номера уточните, пожалуйста:');
    expect(step2).toContain('объем');
    expect(step2).toContain('форму оплаты');
    expect(step2).toContain('сколько метров по длине пола займет груз в кузове');
    expect(step2).not.toContain('маршрут');
    expect(step2).not.toContain('вес');

    runLlmTurn.mockResolvedValueOnce({
      reply: 'Уточните, пожалуйста, только объем в кубометрах.',
      newHistoryEntries: [{ role: 'assistant', content: 'Уточните, пожалуйста, только объем в кубометрах.' }],
      sessionEnded: false,
    });
    const step3 = await handleConversation('scn-ctx-followup', 'ок');
    expect(step3).toBe('Уточните, пожалуйста, только объем в кубометрах.');
    expect(getSession('scn-ctx-followup')?.data.chatMode).toBe('survey_estimate_only');
  });

  it('scn-all-data-at-once-then-thanks', async () => {
    const { handleConversation } = await import('./service.js');

    await handleConversation('scn-all-data', 'добрый день');
    const step2 = await handleConversation('scn-all-data', 'не хочу');
    expect(step2).toBe(ESTIMATE_ONLY_PROMPT);

    runLlmTurn.mockResolvedValueOnce({
      reply: 'Принято. Все данные есть, передаю на расчет.',
      newHistoryEntries: [{ role: 'assistant', content: 'Принято. Все данные есть, передаю на расчет.' }],
      sessionEnded: false,
    });
    const step3 = await handleConversation(
      'scn-all-data',
      'мск спб, стекло, 2 тонны, 3 куба, наличка, 5 палетов',
    );
    expect(step3).toBe('Принято. Все данные есть, передаю на расчет.');

    runLlmTurn.mockResolvedValueOnce({
      reply: ESTIMATE_SAVED_REPLY,
      newHistoryEntries: [
        {
          role: 'assistant',
          content: ESTIMATE_SAVED_REPLY,
        },
      ],
      sessionEnded: true,
    });
    const step4 = await handleConversation('scn-all-data', 'да');
    expect(step4).toBe(ESTIMATE_SAVED_REPLY);
    expect(getSession('scn-all-data')?.data.chatMode).toBe('estimate_wait');
  });

  it('scn-big-message-phone-after-opening', async () => {
    const { handleConversation } = await import('./service.js');

    await handleConversation('scn-big-phone', 'добрый день');

    const step2 = await handleConversation(
      'scn-big-phone',
      'ок, вот сразу всё:\nмаршрут мск-спб\nгруз стекло, 2 тонны, 3 куба\nоплата наличка\nмой номер 8 (965) 882-48-85',
    );
    expect(step2).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
    expect(getSession('scn-big-phone')?.data.chatMode).toBe('engaged');
  });

  it('scn-estimate-wait-general-question', async () => {
    saveSession('scn-est-wait-q', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'estimate_wait',
      llmMessages: [{ role: 'assistant', content: 'Расчет принят.' }],
    });
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('scn-est-wait-q', 'как долго ждать?');
    expect(reply).toBe('Принято. Как только расчет будет готов, сразу напишем в этот чат.');
  });

  it('scn-estimate-wait-callback-hours', async () => {
    saveSession('scn-est-wait-cb', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'estimate_wait',
      llmMessages: [{ role: 'assistant', content: 'Расчет принят.' }],
    });
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('scn-est-wait-cb', 'когда перезвоните?');
    expect(reply).toBe(
      'Мы работаем в будни с 8-00 до 18-00  в рабочие дни пн-пт по Москве.В начала рабочего времени, у нас будут данные какие машины будут свободные под Ваш груз.И сориентировать Вас по стоимости.',
    );
  });

  it('scn-post-quote-neutral-falls-to-phone-backfill', async () => {
    saveSession('scn-pq-neutral', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'post_quote',
      postQuotePhase: 'awaiting_sentiment',
      llmMessages: [{ role: 'assistant', content: 'Предложение готово.' }],
    });
    classifyPriceReaction.mockResolvedValueOnce('neutral');
    runLlmTurn.mockResolvedValueOnce({
      reply: 'Напишите ваш номер телефона для связи с логистом.',
      newHistoryEntries: [{ role: 'assistant', content: 'Напишите ваш номер телефона для связи с логистом.' }],
      sessionEnded: false,
    });
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('scn-pq-neutral', 'посмотрим');
    expect(reply).toBe('Напишите ваш номер телефона для связи с логистом.');
    expect(getSession('scn-pq-neutral')?.data.chatMode).toBe('phone_backfill');
  });

  // ─── STRESS TESTS ──────────────────────────────────────────────────────────

  it('scn-stress-empty-first-message', async () => {
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('scn-empty-msg', '');
    expect(reply).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');
  });

  it('scn-stress-emoji-only-first-message', async () => {
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('scn-emoji-only', '👍🚚 📦');
    expect(reply).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');
  });

  it('scn-stress-refusal-and-phone-in-one-message', async () => {
    // "не хочу" + телефон в одном сообщении: телефон должен выиграть
    const { handleConversation } = await import('./service.js');
    await handleConversation('scn-refuse-plus-phone', 'добрый день');
    const reply = await handleConversation(
      'scn-refuse-plus-phone',
      'не хочу давать, но вот телефон 89658824885',
    );
    expect(reply).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
    expect(getSession('scn-refuse-plus-phone')?.data.chatMode).toBe('engaged');
  });

  it('scn-stress-caps-lock-refusal-with-cargo-data', async () => {
    // Клиент пишет КАПСЛОКОМ; бот должен корректно распознать маршрут/груз/вес и спросить только недостающее
    const { handleConversation } = await import('./service.js');
    await handleConversation('scn-caps', 'ДОБРЫЙ ДЕНЬ МСК СПБ СТЕКЛО 2 ТОННЫ');
    classifyEstimateFields.mockResolvedValueOnce({
      route: true, cargo: true, weight: true, volume: false, payment: false, floorMeters: false,
    });
    const reply = await handleConversation('scn-caps', 'НЕ ДАМ НОМЕР');
    expect(reply).toContain('Принято. Для расчета в чате без номера уточните, пожалуйста:');
    expect(reply).toContain('объем');
    expect(reply).toContain('форму оплаты');
    expect(reply).toContain('сколько метров по длине пола займет груз в кузове');
    expect(reply).not.toContain('маршрут');
    expect(reply).not.toContain('вес');
    expect(getSession('scn-caps')?.data.chatMode).toBe('survey_estimate_only');
  });

  it('scn-stress-off-topic-question-gets-followup', async () => {
    // Нерелевантный вопрос без ключевых слов цены/груза → шаблон повторного запроса телефона
    const { handleConversation } = await import('./service.js');
    await handleConversation('scn-off-topic', 'добрый день');
    const reply = await handleConversation('scn-off-topic', 'ВЫ ВООБЩЕ РАБОТАЕТЕ??? ОТВЕТЬТЕ НЕМЕДЛЕННО!!!');
    expect(reply).toBe('Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');
  });

  it('scn-stress-two-phones-in-one-message-takes-first', async () => {
    const { handleConversation } = await import('./service.js');
    await handleConversation('scn-two-phones', 'добрый день');
    const reply = await handleConversation(
      'scn-two-phones',
      'позвоните мне на 89001234567 или на 89009876543',
    );
    expect(reply).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
    // первый номер должен быть сохранён
    const { getClientByChatId } = await import('../../infrastructure/storage/repository.js');
    expect(getClientByChatId('scn-two-phones')?.phone).toBe('+79001234567');
  });

  it('scn-stress-whitespace-only-in-estimate-only', async () => {
    // Пробелы и переносы строк без данных → снова стартовый шаблон
    saveSession('scn-whitespace-est', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'survey_estimate_only',
      llmMessages: [{ role: 'assistant', content: ESTIMATE_ONLY_PROMPT }],
    });
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('scn-whitespace-est', '   \n  \n  ');
    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
  });

  it('scn-stress-bare-number-no-context-loops-start-prompt', async () => {
    // Голое число без единиц/ключевых слов не считается конкретными данными
    saveSession('scn-bare-num', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'survey_estimate_only',
      llmMessages: [{ role: 'assistant', content: ESTIMATE_ONLY_PROMPT }],
    });
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('scn-bare-num', '5000');
    expect(reply).toBe(ESTIMATE_ONLY_PROMPT);
  });

  it('scn-stress-weight-only-recognized-proceeds-to-llm', async () => {
    // Одно слово с весом уже считается конкретными данными → уходит в LLM, не зацикливается
    saveSession('scn-weight-only', 'LLM', {
      ...LLM_DATA_BASE,
      chatMode: 'survey_estimate_only',
      llmMessages: [{ role: 'assistant', content: ESTIMATE_ONLY_PROMPT }],
    });
    runLlmTurn.mockResolvedValueOnce({
      reply: 'Принято. Уточните маршрут, характер груза, объем, форму оплаты и длину по полу.',
      newHistoryEntries: [
        {
          role: 'assistant',
          content: 'Принято. Уточните маршрут, характер груза, объем, форму оплаты и длину по полу.',
        },
      ],
      sessionEnded: false,
    });
    const { handleConversation } = await import('./service.js');
    const reply = await handleConversation('scn-weight-only', '5 тонн');
    expect(reply).not.toBe(ESTIMATE_ONLY_PROMPT);
    expect(runLlmTurn).toHaveBeenCalledOnce();
  });

  it('scn-stress-angry-message-repeated-three-times', async () => {
    // Одно и то же грубое сообщение три раза подряд → стабильный ответ без краша
    const { handleConversation } = await import('./service.js');
    await handleConversation('scn-angry-repeat', 'добрый день');
    const angry = 'ВЫ ВООБЩЕ РАБОТАЕТЕ??? ОТВЕТЬТЕ НЕМЕДЛЕННО!!!';
    for (let i = 0; i < 3; i++) {
      const reply = await handleConversation('scn-angry-repeat', angry);
      expect(reply).toBe('Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');
    }
  });
});

