export const PHONE_INTENT_OPENING_REPLY =
  'Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.';

export const THANKS_CALLBACK_SOON = 'Спасибо, мы перезвоним вам в ближайшее время.';

export const CALLBACK_HOURS_DASH = 'Мы работаем в будни с 9-00 до 18-00 по Москве.';

export const CALLBACK_HOURS_COLON = 'Мы работаем в будни с 9:00 до 18:00 по Москве.';

export const OUTSIDE_HOURS_REPLY =
  'Здравствуйте! Мы работаем в будние дни с 9:00 до 18:00 по МСК. Напишите нам в рабочее время — мы сразу рассчитаем стоимость вашей перевозки.';

export const POST_QUOTE_PHONE_PROMPT =
  'Напишите свой номер телефона, чтоб обсудить детали с логистом, кто занимается вашим направлением.';

export const POST_QUOTE_NEGATIVE_REPLY =
  'Очень жаль, если у вас поменяется бюджет мы готовы вам помочь. Спасибо.';

export const ESTIMATE_WAITING_REPLY =
  'Ожидайте, пожалуйста: как только расчет цены будет готов, мы сразу ответим вам в этом чате.';

export const ENGAGED_REOPEN_PROMPT =
  'Спасибо за сообщение. Уточните, пожалуйста, ваш вопрос. Если хотите оформить новую перевозку, напишите маршрут, груз и вес.';

export const ESTIMATE_ONLY_START_PROMPT =
  'Хорошо, давайте тогда рассчитаем стоимость грузоперевозки здесь. Для этого мне понадобятся следующие данные:\n\n' +
  '1.  **Откуда и куда** нужно перевезти груз (город, адрес).\n' +
  '2.  **Что именно** нужно перевезти (тип груза, габариты, вес).\n' +
  '3.  **Когда** планируется перевозка (дата, время).\n' +
  '4.  **Дополнительные услуги** (например, грузчики, упаковка, страховка).\n\n' +
  'Как только у меня будет эта информация, я смогу предоставить вам более точный расчет.';

const CALLBACK_WORDS = /(когда|во\s*сколько|перезвон|позвон|свяж)/i;

export function isWhenCallbackQuestion(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  return CALLBACK_WORDS.test(clean);
}

const PRICE_QUERY_WORDS =
  /(цен[уаы]|стоимост[ьи]|расчёт|расчет|рассчита|посчита|сколько\s*стоит|прайс|тариф|калькул|смет[ауе]|почём|почем)/i;

export function isPriceQuery(text: string): boolean {
  if (!text) return false;
  return PRICE_QUERY_WORDS.test(text.trim());
}

export function isWorkingHoursMoscow(): boolean {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const moscow = new Date(utcMs + 3 * 60 * 60_000); // UTC+3
  const day = moscow.getDay(); // 0=Sun, 6=Sat
  const hour = moscow.getHours();
  if (day === 0 || day === 6) return false;
  return hour >= 9 && hour < 18;
}
