export const PHONE_INTENT_OPENING_REPLY =
  'Здравствуйте. Напишите свой номер телефона, свяжемся с вами.';

export const THANKS_CALLBACK_SOON = 'Спасибо, мы перезвоним вам в ближайшее время.';

export const CALLBACK_HOURS_DASH = 'Мы работаем в будни с 8-00 до 18-00 по Москве.';

export const CALLBACK_HOURS_COLON = 'Мы работаем в будни с 8:00 до 18:00 по Москве.';

export const POST_QUOTE_PHONE_PROMPT =
  'Напишите свой номер телефона, чтоб обсудить детали с логистом, кто занимается вашим направлением.';

export const POST_QUOTE_NEGATIVE_REPLY =
  'Очень жаль, если у вас поменяется бюджет мы готовы вам помочь. Спасибо.';

const CALLBACK_WORDS = /(когда|во\s*сколько|перезвон|позвон|свяж)/i;

export function isWhenCallbackQuestion(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  return CALLBACK_WORDS.test(clean);
}
