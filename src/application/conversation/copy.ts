export const PHONE_INTENT_OPENING_REPLY =
  'Здравствуйте. Напишите свой номер телефона, свяжемся с Вами и обсудим детали грузоперевозки.';

export const THANKS_CALLBACK_SOON = 'Спасибо, мы перезвоним вам в ближайшее время.';

export const CALLBACK_HOURS_DASH = 'Мы работаем в будни с 8-00 до 18-00 по Москве.';

export const CALLBACK_HOURS_COLON = 'Мы работаем в будни с 8:00 до 18:00 по Москве.';

export const POST_QUOTE_PHONE_PROMPT =
  'Напишите свой номер телефона, чтоб обсудить детали с логистом, кто занимается вашим направлением.';

export const POST_QUOTE_NEGATIVE_REPLY =
  'Очень жаль, если у вас поменяется бюджет мы готовы вам помочь. Спасибо.';

export const ESTIMATE_WAITING_REPLY =
  'Ожидайте, пожалуйста: как только расчет цены будет готов, мы сразу ответим вам в этом чате.';

export const ENGAGED_REOPEN_PROMPT =
  'Спасибо за сообщение. Уточните, пожалуйста, ваш вопрос. Если хотите оформить новую перевозку, напишите маршрут, груз и вес.';

export const ESTIMATE_ONLY_START_PROMPT =
  'Хорошо, считаем в чате без номера. Напишите, пожалуйста: \n' +
  '1.Маршрут (откуда куда везем)\n' +
  '2.Характер груз\n' +
  '3.Вес\n' +
  '4.Объем\n' +
  '5.Форму оплаты(наличные,безнал б/ндс, безнал с НДС)\n' +
  '6.Сколько примерно в метрах займет Ваш груз в кузове у нас по длине пола(при ширине кузова 2.4 метра)';

const CALLBACK_WORDS = /(когда|во\s*сколько|перезвон|позвон|свяж)/i;

export function isWhenCallbackQuestion(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  return CALLBACK_WORDS.test(clean);
}
