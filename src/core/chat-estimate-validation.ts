/**
 * Серверная валидация полей для второго сценария (submit_chat_estimate_request).
 * Ошибки формулируются так, чтобы LLM мог передать клиенту понятный дозапрос.
 */

export type ChatEstimateFieldKey = 'route' | 'cargo' | 'weight' | 'payment_method';

export interface ChatEstimateValidationOk {
  ok: true;
}

export interface ChatEstimateValidationError {
  ok: false;
  /** Текст для поля `message` в JSON ответа tool — читает LLM и клиент */
  message: string;
  /** Коды полей для структурированного ответа (опционально для логов/тестов) */
  missing: ChatEstimateFieldKey[];
  /** Поля с размытым значением */
  vague: ChatEstimateFieldKey[];
}

export type ChatEstimateValidationResult = ChatEstimateValidationOk | ChatEstimateValidationError;

const PLACEHOLDER_ROUTE = new Set(['—', '-', '–', 'нет', 'н/д', 'н/а', 'тест', 'test']);
const GENERIC_CARGO = new Set([
  'груз',
  'товар',
  'вещи',
  'материал',
  'разное',
  'что-то',
  'что то',
  'не знаю',
]);

const FIELD_LABELS: Record<ChatEstimateFieldKey, string> = {
  route: 'маршрут (откуда — куда, можно кратко: СПб — Москва)',
  cargo: 'характер груза (конкретно: что везём, не одно слово «товар»)',
  weight: 'вес или масса (число и единица: кг, т, тонны)',
  payment_method: 'форма оплаты (наличные / безнал / с НДС и т.п.)',
};

function normalizeSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function isRouteTooWeak(route: string): boolean {
  const t = normalizeSpaces(route);
  if (t.length < 4) return true;
  if (PLACEHOLDER_ROUTE.has(t.toLowerCase())) return true;
  // хотя бы буквы (не только пунктуация/цифры в короткой строке)
  if (t.length < 8 && !/[а-яёa-z]/i.test(t)) return true;
  return false;
}

function isCargoTooGeneric(cargo: string): boolean {
  const t = normalizeSpaces(cargo).toLowerCase();
  if (t.length < 3) return true;
  if (GENERIC_CARGO.has(t)) return true;
  if (t.length <= 12 && GENERIC_CARGO.has(t.split(/\s+/)[0] ?? '')) return true;
  return false;
}

function hasWeightNumber(weight: string): boolean {
  return /\d/.test(normalizeSpaces(weight));
}

function isPaymentWeak(payment: string): boolean {
  const t = normalizeSpaces(payment);
  if (t.length < 2) return true;
  if (/^[?.!\-—–]+$/u.test(t)) return true;
  if (PLACEHOLDER_ROUTE.has(t.toLowerCase())) return true;
  return false;
}

/**
 * Проверяет поля заявки на расчёт в чате. Не сохраняет в БД.
 */
export function validateChatEstimateFields(input: {
  route: string;
  cargo: string;
  weight: string;
  payment_method: string;
}): ChatEstimateValidationResult {
  const route = normalizeSpaces(input.route);
  const cargo = normalizeSpaces(input.cargo);
  const weight = normalizeSpaces(input.weight);
  const payment_method = normalizeSpaces(input.payment_method);

  const missing: ChatEstimateFieldKey[] = [];
  const vague: ChatEstimateFieldKey[] = [];

  if (!route) missing.push('route');
  else if (isRouteTooWeak(route)) vague.push('route');

  if (!cargo) missing.push('cargo');
  else if (isCargoTooGeneric(cargo)) vague.push('cargo');

  if (!weight) missing.push('weight');
  else if (!hasWeightNumber(weight)) vague.push('weight');

  if (!payment_method) missing.push('payment_method');
  else if (isPaymentWeak(payment_method)) vague.push('payment_method');

  if (missing.length === 0 && vague.length === 0) {
    return { ok: true };
  }

  const parts: string[] = [
    'Сохранение отклонено: данные неполные или слишком общие для расчёта в чате.',
  ];
  if (missing.length > 0) {
    parts.push(
      `Пустые или не переданы поля: ${missing.map((k) => FIELD_LABELS[k]).join('; ')}.`,
    );
  }
  if (vague.length > 0) {
    parts.push(
      `Нужно уточнить у клиента: ${vague.map((k) => FIELD_LABELS[k]).join('; ')}.`,
    );
  }
  parts.push(
    'НЕ пиши, что параметры уже сохранены или переданы логисту. Кратко попроси только недостающее, по делу, по-русски.',
  );

  return {
    ok: false,
    message: parts.join(' '),
    missing,
    vague,
  };
}
