import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDatabaseForTests, getSession, saveSession, type SessionData } from '../../infrastructure/storage/repository.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// Live tests should validate LLM behavior, not Avito transport layer.
vi.mock('../../integrations/avito/client.js', () => ({
  resolveUserId: vi.fn().mockResolvedValue('bot'),
  getChatById: vi.fn().mockResolvedValue({
    users: [
      { id: 'bot', name: 'Bot' },
      { id: 'u1', name: 'Клиент' },
    ],
    context: { value: { id: 'it-live' } },
  }),
}));

const ESTIMATE_ONLY_PROMPT =
  'Хорошо, считаем в чате без номера. Напишите, пожалуйста: \n' +
  '1.Маршрут (откуда куда везем)\n' +
  '2.Характер груз\n' +
  '3.Вес\n' +
  '4.Объем\n' +
  '5.Форму оплаты(наличные,безнал б/ндс, безнал с НДС)\n' +
  '6.Сколько примерно в метрах займет Ваш груз в кузове у нас по длине пола(при ширине кузова 2.4 метра)';

const shouldRunLive = process.env.LIVE_LLM === '1' && Boolean(process.env.OPENAI_API_KEY?.trim());
const repeatRunsRaw = Number.parseInt(process.env.LIVE_LLM_REPEATS ?? '5', 10);
const repeatRuns = Number.isFinite(repeatRunsRaw) && repeatRunsRaw > 0 ? repeatRunsRaw : 5;
const maybeDescribe = shouldRunLive ? describe : describe.skip;

maybeDescribe('live llm conversation scenarios', () => {
  beforeEach(() => {
    clearDatabaseForTests();
  });

  function expectNoGenericFailure(reply: string): void {
    expect(reply).toBeTruthy();
    expect(reply).not.toBe('Извините, сейчас не получилось обработать сообщение. Напишите ещё раз чуть позже.');
    expect(reply).not.toContain('К сожалению, в данном режиме я не могу запросить номер телефона');
    expect(reply).not.toContain('*');
  }

  async function sendAndLog(
    handleConversation: (chatId: string, text: string) => Promise<string>,
    chatId: string,
    userText: string,
  ): Promise<string> {
    console.log(`\n[${chatId}] CLIENT: ${userText}`);
    const reply = await handleConversation(chatId, userText);
    console.log(`[${chatId}] BOT: ${reply || '(no reply)'}`);
    return reply;
  }

  async function runRepeated(
    scenarioId: string,
    fn: (attempt: number) => Promise<void>,
  ): Promise<void> {
    for (let attempt = 1; attempt <= repeatRuns; attempt += 1) {
      clearDatabaseForTests();
      console.log(`\n[${scenarioId}] ===== RUN ${attempt}/${repeatRuns} =====`);
      await fn(attempt);
    }
  }

  it(
    'full flow: greeting -> refusal without data -> fixed template loop',
    async () => {
      await runRepeated('live-flow-template-loop', async (attempt) => {
        const { handleConversation } = await import('./service.js');
        const chatId = `live-flow-template-loop-${attempt}`;
        const step1 = await sendAndLog(handleConversation, chatId, 'добрый день');
        expect(step1).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');
        const step2 = await sendAndLog(handleConversation, chatId, 'не хочу');
        expect(step2).toBe(ESTIMATE_ONLY_PROMPT);
        const step3 = await sendAndLog(handleConversation, chatId, 'ок');
        expect(step3).toBe(ESTIMATE_ONLY_PROMPT);
        expect(getSession(chatId)?.data.chatMode).toBe('survey_estimate_only');
      });
    },
    300_000 * repeatRuns,
  );

  it(
    'full flow: first message with phone -> accepted -> closing silent',
    async () => {
      await runRepeated('live-flow-first-phone', async (attempt) => {
        const { handleConversation } = await import('./service.js');
        const chatId = `live-flow-first-phone-${attempt}`;
        const step1 = await sendAndLog(handleConversation, chatId, 'добрый день, мой номер 89658824885');
        expect(step1).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
        const step2 = await sendAndLog(handleConversation, chatId, 'договорились');
        expect(step2).toBe('👍');
        const step3 = await sendAndLog(handleConversation, chatId, 'спасибо');
        expect(step3).toBe('');
      });
    },
    300_000 * repeatRuns,
  );

  it(
    'full flow: refusal with data -> llm followup -> late phone accepted',
    async () => {
      await runRepeated('live-flow-late-phone', async (attempt) => {
        const chatId = `live-flow-late-phone-${attempt}`;
        saveSession(chatId, 'LLM', {
          itemId: 'it-live-1',
          clientName: 'Клиент',
          cargo: '',
          weight: '',
          volume: '',
          route: '',
          paymentMethod: '',
          phone: '',
          chatMode: 'survey_estimate_only',
          llmMessages: [{ role: 'assistant', content: ESTIMATE_ONLY_PROMPT }],
        } satisfies SessionData);

        const { handleConversation } = await import('./service.js');
        const step1 = await sendAndLog(
          handleConversation,
          chatId,
          'спб мск, стекло, 2 тонны, 3 куба, наличка, 5 палетов',
        );
        expectNoGenericFailure(step1);
        const step2 = await sendAndLog(
          handleConversation,
          chatId,
          'тогда по номеру 8 (965) 882-48-85',
        );
        expect(step2).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
        const step3 = await sendAndLog(handleConversation, chatId, 'спасибо');
        expect(step3).toBe('👍');
      });
    },
    300_000 * repeatRuns,
  );

  it(
    'full flow: greeting with cargo -> still phone first -> refusal -> contextual missing fields',
    async () => {
      await runRepeated('live-flow-contextual', async (attempt) => {
        const { handleConversation } = await import('./service.js');
        const chatId = `live-flow-contextual-${attempt}`;
        const step1 = await sendAndLog(handleConversation, chatId, 'добрый день, мск спб, стекло, 2 тонны');
        expect(step1).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');
        const step2 = await sendAndLog(handleConversation, chatId, 'номер не дам');
        expect(step2).toContain('Для расчета в чате без номера уточните, пожалуйста:');
        expect(step2).toContain('объем');
        expect(step2).toContain('форму оплаты');
        expect(step2).toContain('сколько метров по длине пола займет груз в кузове');
        expect(step2).not.toContain('маршрут');
        expect(step2).not.toContain('характер груза');
        expect(step2).not.toContain('вес');
      });
    },
    300_000 * repeatRuns,
  );

  it(
    'full flow: estimate-only multi-step should not produce generic failure',
    async () => {
      await runRepeated('live-flow-no-fail', async (attempt) => {
        const { handleConversation } = await import('./service.js');
        const chatId = `live-flow-no-fail-${attempt}`;
        await sendAndLog(handleConversation, chatId, 'привет');
        await sendAndLog(handleConversation, chatId, 'не хочу');
        const step3 = await sendAndLog(handleConversation, chatId, 'спб мск, стекло');
        expectNoGenericFailure(step3);
        const step4 = await sendAndLog(handleConversation, chatId, '2 тонны');
        expectNoGenericFailure(step4);
      });
    },
    300_000 * repeatRuns,
  );

  it(
    'full flow: loading points are sent one-by-one',
    async () => {
      await runRepeated('live-flow-loading-by-one', async (attempt) => {
        const { handleConversation } = await import('./service.js');
        const chatId = `live-flow-loading-by-one-${attempt}`;

        const s1 = await sendAndLog(handleConversation, chatId, 'добрый день');
        expect(s1).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');

        const s2 = await sendAndLog(handleConversation, chatId, 'не хочу давать номер');
        expect(s2).toBe(ESTIMATE_ONLY_PROMPT);

        const s3 = await sendAndLog(handleConversation, chatId, 'загрузка: аксайский проспект 19А');
        expectNoGenericFailure(s3);
        expect(s3).not.toContain('Извините, сейчас не получилось обработать сообщение');

        const s4 = await sendAndLog(handleConversation, chatId, 'загрузка: ул. Днепропетровская 52а');
        expectNoGenericFailure(s4);

        const s5 = await sendAndLog(handleConversation, chatId, 'выгрузка: ул. Изумрудная 9');
        expectNoGenericFailure(s5);

        const s6 = await sendAndLog(
          handleConversation,
          chatId,
          'груз: даска 45*145*4м - 11шт, брус 45*45*3 - 27шт',
        );
        expectNoGenericFailure(s6);

        const s7 = await sendAndLog(handleConversation, chatId, 'вес 2 тонны');
        expectNoGenericFailure(s7);

        const s8 = await sendAndLog(handleConversation, chatId, '3 куба, наличка, 5 палетов');
        expectNoGenericFailure(s8);
      });
    },
    300_000 * repeatRuns,
  );

  it(
    'full flow: multi-point nonstandard cargo long message',
    async () => {
      await runRepeated('live-flow-multipoint-long', async (attempt) => {
        const { handleConversation } = await import('./service.js');
        const chatId = `live-flow-multipoint-long-${attempt}`;

        const s1 = await sendAndLog(
          handleConversation,
          chatId,
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
        expect(s1).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');

        const s2 = await sendAndLog(handleConversation, chatId, 'все детали выше');
        expectNoGenericFailure(s2);
        expect(s2).toContain('Для расчета в чате без номера уточните, пожалуйста:');

        const s3 = await sendAndLog(handleConversation, chatId, 'тонна 5 палетов наличка 3 куба');
        expectNoGenericFailure(s3);
        expect(s3).not.toContain('По\nчто');
      });
    },
    300_000 * repeatRuns,
  );

  it(
    'full flow: invalid phone mask then repeated same invalid phone accepted',
    async () => {
      await runRepeated('live-flow-invalid-phone', async (attempt) => {
        const { handleConversation } = await import('./service.js');
        const chatId = `live-flow-invalid-phone-${attempt}`;
        const s1 = await sendAndLog(handleConversation, chatId, 'добрый день');
        expect(s1).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');
        const s2 = await sendAndLog(handleConversation, chatId, 'мой номер 8 999 111 22 33 44');
        expect(s2).toBe('Ваш номер указан не верно, просьба проверить цифры.');
        const s3 = await sendAndLog(handleConversation, chatId, 'мой номер 8 999 111 22 33 44');
        expect(s3).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
      });
    },
    300_000 * repeatRuns,
  );

  it(
    'full flow: client sends pricing data one message at a time',
    async () => {
      await runRepeated('live-flow-price-one-by-one', async (attempt) => {
        const { handleConversation } = await import('./service.js');
        const chatId = `live-flow-price-one-by-one-${attempt}`;

        const s1 = await sendAndLog(handleConversation, chatId, 'добрый день');
        expect(s1).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');

        const s2 = await sendAndLog(handleConversation, chatId, 'не хочу давать номер');
        expect(s2).toBe(ESTIMATE_ONLY_PROMPT);

        const s3 = await sendAndLog(handleConversation, chatId, 'маршрут спб мск');
        expectNoGenericFailure(s3);
        expect(s3.toLowerCase()).toMatch(/уточните|укажите|нужно|теперь/);

        const s4 = await sendAndLog(handleConversation, chatId, 'груз стекло');
        expectNoGenericFailure(s4);
        const s5 = await sendAndLog(handleConversation, chatId, 'вес 2 тонны');
        expectNoGenericFailure(s5);
        const s6 = await sendAndLog(handleConversation, chatId, '3 куба');
        expectNoGenericFailure(s6);
        const s7 = await sendAndLog(handleConversation, chatId, 'наличка');
        expectNoGenericFailure(s7);
        const s8 = await sendAndLog(handleConversation, chatId, '5 палетов');
        expectNoGenericFailure(s8);
      });
    },
    300_000 * repeatRuns,
  );

  it(
    'full flow: big message contains phone after first request',
    async () => {
      await runRepeated('live-flow-big-message-phone', async (attempt) => {
        const { handleConversation } = await import('./service.js');
        const chatId = `live-flow-big-message-phone-${attempt}`;

        const s1 = await sendAndLog(handleConversation, chatId, 'добрый день');
        expect(s1).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');

        const s2 = await sendAndLog(
          handleConversation,
          chatId,
          [
            'ок, вот сразу всё:',
            'маршрут мск-спб',
            'груз стекло, 2 тонны, 3 куба',
            'оплата наличка',
            'мой номер 8 (965) 882-48-85',
          ].join('\n'),
        );
        expect(s2).toBe('Спасибо, мы перезвоним вам в ближайшее время.');
      });
    },
    300_000 * repeatRuns,
  );

  it(
    'full flow: does not forget cargo context (glass) inside estimate chat',
    async () => {
      await runRepeated('live-flow-keep-cargo-context', async (attempt) => {
        const { handleConversation } = await import('./service.js');
        const chatId = `live-flow-keep-cargo-context-${attempt}`;

        const s1 = await sendAndLog(handleConversation, chatId, 'давайте в чате');
        expect(s1).toBe('Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.');

        const s2 = await sendAndLog(handleConversation, chatId, 'не хочу');
        expect(s2).toBe(ESTIMATE_ONLY_PROMPT);

        await sendAndLog(handleConversation, chatId, 'мск спб');
        await sendAndLog(handleConversation, chatId, 'стекло');
        await sendAndLog(handleConversation, chatId, '5 палетов');
        await sendAndLog(handleConversation, chatId, '2 куба 2 тонны');
        const s7 = await sendAndLog(handleConversation, chatId, 'и наличка');

        expectNoGenericFailure(s7);
        expect(s7.toLowerCase()).not.toContain('какой характер груза');
        expect(s7.toLowerCase()).not.toContain('уточните характер груза');
        expect(s7.toLowerCase()).not.toContain('подскажите характер груза');
      });
    },
    300_000 * repeatRuns,
  );
});

