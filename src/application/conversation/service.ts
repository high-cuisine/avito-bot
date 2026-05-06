import { normalizePhone } from '../../core/phone.js';
import { logger } from '../../core/logger.js';
import {
  resolveUserId,
  getChatById,
  type AvitoChat,
} from '../../integrations/avito/client.js';
import { classifyPriceReaction, runLlmTurn } from '../../integrations/openai/chat.js';
import { postSubmitWebhook } from '../../integrations/webhook/submit-lead.js';
import { executeSubmitPhoneBackfill } from './execute-submit.js';
import {
  CALLBACK_HOURS_COLON,
  CALLBACK_HOURS_DASH,
  ENGAGED_REOPEN_PROMPT,
  ESTIMATE_WAITING_REPLY,
  ESTIMATE_ONLY_START_PROMPT,
  OUTSIDE_HOURS_REPLY,
  PHONE_INTENT_OPENING_REPLY,
  POST_QUOTE_NEGATIVE_REPLY,
  POST_QUOTE_PHONE_PROMPT,
  THANKS_CALLBACK_SOON,
  isPriceQuery,
  isWhenCallbackQuestion,
  isWorkingHoursMoscow,
} from './copy.js';
import {
  getSession,
  saveSession,
  saveClient,
  deleteSession,
  getClientByChatId,
  getChatEstimateByChatId,
  type SessionData,
  type LlmChatMessage,
} from '../../infrastructure/storage/repository.js';

const LLM_STATE = 'LLM';
const MAX_LLM_HISTORY = 40;

const LEGACY_STATES = new Set([
  'ASK_CARGO',
  'ASK_ROUTE',
  'ASK_PAYMENT',
  'ASK_PHONE',
  'ASK_PHONE_BACKFILL',
  'CONFIRM_PHONE_BACKFILL',
  'CONFIRM',
]);

const PHONE_REFUSAL_HINTS = [
  'без номера',
  'номер не дам',
  'номер не даю',
  'не дам номер',
  'не даю номер',
  'не дам',
  'не даю',
  'не буду давать',
  'не хочу номер',
  'не хочу оставлять номер',
  'не хочу давать номер',
  'телефон не дам',
  'телефон не даю',
  'телефон не буду давать',
  'без телефона',
];
const PHONE_REFUSAL_RE =
  /(без\s*(номера|телефона))|((не\s*хоч|не\s*буд|не\s*мог|не\s*готов).{0,30}(да(ва|ть)|остав(ля|ить)|писа(ть|ть)|указыва(ть|ть)).{0,20}(номер|телефон))|((номер|телефон).{0,20}(не\s*дам|не\s*даю|не\s*оставлю))/i;

const PRICE_FIRST_HINTS = [
  'посчитайте цену',
  'рассчитайте цену',
  'расчитайте цену',
  'расчитайте',
  'расчет цены',
  'сначала цену',
  'цену сначала',
  'цена сначала',
  'хочу сначала цену',
  'сначала хочу цену',
  'посчитать цену в чате',
  'расчет в чате',
];

const ESTIMATE_ONLY_HINTS = [
  'второй вариант',
  'да в чате',
  'в чате',
  'без звонка',
  'без номера',
  'без телефона',
  'детали все указаны',
  'детали указаны',
  'детали все есть',
  'детали есть',
  'все данные указаны',
  'все данные есть',
  'все данные выше',
  'данные все указаны',
];
const ESTIMATE_ONLY_INDIRECT_RE =
  /((детал[ьи]).{0,20}(все\s*)?(есть|указан))|((все\s+данн(ые|ая)).{0,20}(есть|указан))/i;

const PHONE_REQUEST_PATTERN =
  /(напиш|укаж|пришл|остав(ь|ьте)).{0,40}(номер|телефон)|(номер|телефон).{0,40}(\+7|8\d{10})/i;
const INVALID_PHONE_REPLY = 'Ваш номер указан не верно, просьба проверить цифры.';
const PAYMENT_RE = /(налич|безнал|ндс|с\s*ндс|б\/ндс)/i;
const VOLUME_RE = /(об[ъь]?[её]м|м3|куб|кубометр)/i;
const FLOOR_METERS_RE = /(метр|по\s+длине\s+пола|длина\s+пола|в\s+кузове)/i;

function isPhoneRefusalText(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return PHONE_REFUSAL_HINTS.some((hint) => normalized.includes(hint)) || PHONE_REFUSAL_RE.test(normalized);
}

function isPriceFirstRequestText(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return PRICE_FIRST_HINTS.some((hint) => normalized.includes(hint)) || isPriceQuery(normalized);
}

function isEstimateOnlyChoiceText(text: string): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return ESTIMATE_ONLY_HINTS.some((hint) => normalized.includes(hint)) || ESTIMATE_ONLY_INDIRECT_RE.test(normalized);
}

function isWithoutPhoneChoiceText(text: string): boolean {
  return isPhoneRefusalText(text) || isPriceFirstRequestText(text) || isEstimateOnlyChoiceText(text);
}

function enforceNoPhoneInEstimateMode(mode: SessionData['chatMode'], reply: string): string {
  const cleaned =
    mode === 'survey_estimate_only' || mode === 'estimate_wait'
      ? reply.replace(/\*/g, '')
      : reply;
  if ((mode === 'survey_estimate_only' || mode === 'estimate_wait') && PHONE_REQUEST_PATTERN.test(cleaned)) {
    return ESTIMATE_ONLY_START_PROMPT;
  }
  return cleaned;
}

function hasAnyAssistantHistory(history: LlmChatMessage[]): boolean {
  return history.some((m) => m.role === 'assistant');
}

function extractPhoneLikeDigits(text: string): string | null {
  const m = text.match(/\+?\d[\d\s().-]{7,}\d/);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, '');
  return digits || null;
}

function getInvalidPhoneAttemptKey(text: string): string | null {
  const digits = extractPhoneLikeDigits(text);
  if (!digits) return null;
  if (digits.length === 10 || digits.length === 11) return null;
  return digits;
}

function hasMeaningfulText(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!t) return false;
  if (isPriceFirstRequestText(t)) return false;
  if (/^(привет|здравствуйте|добрый\s+день|добрый\s+вечер|доброе\s+утро)$/i.test(t)) return false;
  return /[а-яёa-z0-9]/i.test(t);
}

function normalizeLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function buildEstimateOnlyFollowupFromText(text: string): string | null {
  const lines = normalizeLines(text);
  const normalized = lines.map((l) => l.toLowerCase());

  const hasRoute =
    normalized.some((l) => /\b(мск|москва|спб|санкт-?петербург)\b/.test(l)) ||
    normalized.some((l) => /(откуда|куда|маршрут)/.test(l)) ||
    normalized.some((l) => /\b.+\s*[-–—>]\s*.+\b/.test(l)) ||
    normalized.some((l) =>
      /(мск|москва|спб|санкт-?петербург).{0,20}(мск|москва|спб|санкт-?петербург)/.test(l),
    );
  const hasCargo = normalized.some((l) => /(груз|стекл|мебел|оборуд|короб|паллет|товар)/.test(l));
  const hasWeight = normalized.some((l) => /(вес|кг|тонн|тн|т\.)/.test(l));
  const hasVolume = normalized.some((l) => VOLUME_RE.test(l));
  const hasPayment = normalized.some((l) => PAYMENT_RE.test(l));
  const hasFloorMeters = normalized.some((l) => FLOOR_METERS_RE.test(l));
  const providedCount = [hasRoute, hasCargo, hasWeight, hasVolume, hasPayment, hasFloorMeters].filter(Boolean).length;
  if (providedCount === 0) return null;

  const missing: string[] = [];
  if (!hasRoute) missing.push('маршрут');
  if (!hasCargo) missing.push('характер груза');
  if (!hasWeight) missing.push('вес');
  if (!hasVolume) missing.push('объем');
  if (!hasPayment) missing.push('форму оплаты');
  if (!hasFloorMeters) missing.push('сколько метров по длине пола займет груз в кузове');

  if (missing.length === 0) return null;
  return `Принято. Для расчета в чате без номера уточните, пожалуйста: ${missing.join(', ')}.`;
}

function collectUserTextForEstimate(history: LlmChatMessage[], currentText: string): string {
  const previous = history
    .filter((m): m is Extract<LlmChatMessage, { role: 'user' }> => m.role === 'user')
    .map((m) => m.content.trim())
    .filter(Boolean)
    .join('\n');
  return previous ? `${previous}\n${currentText}` : currentText;
}

function emptyData(): SessionData {
  return {
    itemId: '',
    clientName: '',
    cargo: '',
    weight: '',
    volume: '',
    route: '',
    paymentMethod: '',
    phone: '',
    capturedPhone: undefined,
    llmMessages: [],
  };
}

async function resolveClientInfo(
  chatId: string,
  chatContext?: AvitoChat,
): Promise<{ clientName: string; itemId: string }> {
  let clientName = '';
  let itemId = '';
  let chat = chatContext;
  if (!chat?.users || !chat?.context) {
    try {
      chat = await getChatById(chatId);
    } catch (err) {
      logger.warn({ err, chatId }, 'Could not fetch chat details');
    }
  }

  if (chat) {
    const userId = await resolveUserId();
    const otherUser = chat.users?.find((u) => String(u.id) !== String(userId));
    if (otherUser?.name) clientName = otherUser.name;
    if (chat.context?.value?.id) itemId = String(chat.context.value.id);
  }
  return { clientName, itemId };
}

function appendTurn(data: SessionData, userText: string, entries: LlmChatMessage[]): void {
  const list = data.llmMessages ?? [];
  list.push({ role: 'user', content: userText });
  list.push(...entries);
  while (list.length > MAX_LLM_HISTORY) {
    list.splice(0, list.length - MAX_LLM_HISTORY);
  }
  data.llmMessages = list;
}

async function completePhoneOnlyLead(
  chatId: string,
  data: SessionData,
  phone: string,
): Promise<string> {
  saveClient({
    chatId,
    itemId: data.itemId || '',
    clientName: data.clientName || '',
    cargo: '',
    weight: '',
    volume: '',
    route: '',
    paymentMethod: '',
    phone,
  });
  const whOk = await postSubmitWebhook({
    event: 'transport_lead',
    chat_id: chatId,
    item_id: data.itemId || null,
    client_name: data.clientName || null,
    cargo: null,
    route: null,
    payment_method: null,
    phone,
    submitted_at: new Date().toISOString(),
  });
  if (!whOk) {
    logger.warn({ chatId }, 'Phone-only lead: local save OK but submit webhook failed');
  }
  deleteSession(chatId);
  logger.info({ chatId, phone, webhook_ok: whOk }, 'Phone-only lead completed');
  return THANKS_CALLBACK_SOON;
}

export async function handleConversation(
  chatId: string,
  text: string,
  chatContext?: AvitoChat,
): Promise<string> {
  if (!isWorkingHoursMoscow() && isPriceQuery(text)) {
    logger.info({ chatId }, 'Outside working hours — price query blocked');
    return OUTSIDE_HOURS_REPLY;
  }

  let session = getSession(chatId);

  if (session && LEGACY_STATES.has(session.state)) {
    deleteSession(chatId);
    session = null;
  }

  if (!session) {
    const existingClient = getClientByChatId(chatId);
    if (existingClient && !existingClient.phone) {
      const data: SessionData = {
        ...emptyData(),
        itemId: existingClient.itemId ?? '',
        clientName: existingClient.clientName ?? '',
        cargo: existingClient.cargo ?? '',
        weight: existingClient.weight ?? '',
        volume: existingClient.volume ?? '',
        route: existingClient.route ?? '',
        paymentMethod: existingClient.paymentMethod ?? '',
        phone: '',
        chatMode: 'phone_backfill',
        llmMessages: [],
      };
      saveSession(chatId, LLM_STATE, data);
      session = getSession(chatId);
    } else if (existingClient?.phone) {
      const data: SessionData = {
        ...emptyData(),
        itemId: existingClient.itemId ?? '',
        clientName: existingClient.clientName ?? '',
        cargo: existingClient.cargo ?? '',
        weight: existingClient.weight ?? '',
        volume: existingClient.volume ?? '',
        route: existingClient.route ?? '',
        paymentMethod: existingClient.paymentMethod ?? '',
        phone: existingClient.phone,
        capturedPhone: existingClient.phone,
        chatMode: 'engaged',
        llmMessages: [],
      };
      saveSession(chatId, LLM_STATE, data);
      session = getSession(chatId);
    } else {
      const existingEstimate = getChatEstimateByChatId(chatId);
      if (existingEstimate) {
        const data: SessionData = {
          ...emptyData(),
          itemId: existingEstimate.itemId ?? '',
          clientName: existingEstimate.clientName ?? '',
          cargo: existingEstimate.cargo ?? '',
          weight: existingEstimate.weight ?? '',
          volume: existingEstimate.volume ?? '',
          route: existingEstimate.route ?? '',
          paymentMethod: existingEstimate.paymentMethod ?? '',
          chatMode: 'estimate_wait',
          llmMessages: [],
        };
        saveSession(chatId, LLM_STATE, data);
        session = getSession(chatId);
      }
    }

    if (!session) {
      const { clientName, itemId } = await resolveClientInfo(chatId, chatContext);
      const data: SessionData = {
        ...emptyData(),
        clientName,
        itemId,
        chatMode: 'phone_intent',
        llmMessages: [],
      };
      saveSession(chatId, LLM_STATE, data);
      session = getSession(chatId);
    }
  }

  if (!session || session.state !== LLM_STATE) {
    logger.error({ chatId }, 'Unexpected session state');
    return 'Произошла ошибка. Напишите ещё раз.';
  }

  const { data } = session;
  const mode = data.chatMode ?? 'phone_intent';
  const history: LlmChatMessage[] = data.llmMessages ?? [];

  if (mode === 'phone_intent' && !history.some((m) => m.role === 'assistant')) {
    appendTurn(data, text, [{ role: 'assistant', content: PHONE_INTENT_OPENING_REPLY }]);
    saveSession(chatId, LLM_STATE, data);
    return PHONE_INTENT_OPENING_REPLY;
  }

  if (mode === 'phone_intent' && history.some((m) => m.role === 'assistant')) {
    const earlyPhone = normalizePhone(text);
    if (earlyPhone) {
      data.invalidPhoneAttempt = undefined;
      return completePhoneOnlyLead(chatId, data, earlyPhone);
    }
    const invalidPhoneKey = getInvalidPhoneAttemptKey(text);
    if (invalidPhoneKey) {
      if (data.invalidPhoneAttempt === invalidPhoneKey) {
        data.invalidPhoneAttempt = undefined;
        return completePhoneOnlyLead(chatId, data, text.trim());
      }
      data.invalidPhoneAttempt = invalidPhoneKey;
      appendTurn(data, text, [{ role: 'assistant', content: INVALID_PHONE_REPLY }]);
      saveSession(chatId, LLM_STATE, data);
      return INVALID_PHONE_REPLY;
    }

    if (isWithoutPhoneChoiceText(text)) {
      data.chatMode = 'survey_estimate_only';
      const collected = collectUserTextForEstimate(history, text);
      const followup = buildEstimateOnlyFollowupFromText(collected);
      const scriptReply = followup ?? ESTIMATE_ONLY_START_PROMPT;
      logger.info({ chatId }, 'Client declined phone in phone_intent, switched to estimate-only mode');
      appendTurn(data, text, [{ role: 'assistant', content: scriptReply }]);
      saveSession(chatId, LLM_STATE, data);
      return scriptReply;
    }
    appendTurn(data, text, [{ role: 'assistant', content: PHONE_INTENT_OPENING_REPLY }]);
    saveSession(chatId, LLM_STATE, data);
    return PHONE_INTENT_OPENING_REPLY;
  }

  if (mode === 'survey') {
    const phoneInSurvey = normalizePhone(text);
    if (phoneInSurvey) {
      data.invalidPhoneAttempt = undefined;
      return completePhoneOnlyLead(chatId, data, phoneInSurvey);
    }
    const invalidPhoneKey = getInvalidPhoneAttemptKey(text);
    if (invalidPhoneKey) {
      if (data.invalidPhoneAttempt === invalidPhoneKey) {
        data.invalidPhoneAttempt = undefined;
        return completePhoneOnlyLead(chatId, data, text.trim());
      }
      data.invalidPhoneAttempt = invalidPhoneKey;
      appendTurn(data, text, [{ role: 'assistant', content: INVALID_PHONE_REPLY }]);
      saveSession(chatId, LLM_STATE, data);
      return INVALID_PHONE_REPLY;
    }
    data.chatMode = 'survey_estimate_only';
    logger.info({ chatId }, 'No phone in survey mode, switched to fixed estimate-only prompt');
    appendTurn(data, text, [{ role: 'assistant', content: ESTIMATE_ONLY_START_PROMPT }]);
    saveSession(chatId, LLM_STATE, data);
    return ESTIMATE_ONLY_START_PROMPT;
  }

  if (mode === 'post_quote') {
    const phase = data.postQuotePhase ?? 'awaiting_sentiment';
    if (phase === 'awaiting_sentiment') {
      const reaction = await classifyPriceReaction(text);
      if (reaction === 'positive') {
        data.postQuotePhase = 'awaiting_phone';
        appendTurn(data, text, [{ role: 'assistant', content: POST_QUOTE_PHONE_PROMPT }]);
        saveSession(chatId, LLM_STATE, data);
        return POST_QUOTE_PHONE_PROMPT;
      }
      if (reaction === 'negative') {
        data.chatMode = 'phone_backfill';
        data.postQuotePhase = undefined;
        appendTurn(data, text, [{ role: 'assistant', content: POST_QUOTE_NEGATIVE_REPLY }]);
        saveSession(chatId, LLM_STATE, data);
        return POST_QUOTE_NEGATIVE_REPLY;
      }
      data.chatMode = 'phone_backfill';
      data.postQuotePhase = undefined;
    } else if (phase === 'awaiting_phone') {
      const phone = normalizePhone(text);
      if (phone) {
        const exec = await executeSubmitPhoneBackfill(chatId, { phone });
        data.postQuotePhase = 'phone_captured';
        if (!exec.ok) {
          logger.warn({ chatId, toolContent: exec.toolContent }, 'Post-quote phone save failed');
        }
        appendTurn(data, text, [{ role: 'assistant', content: THANKS_CALLBACK_SOON }]);
        saveSession(chatId, LLM_STATE, data);
        return THANKS_CALLBACK_SOON;
      }
      if (isWhenCallbackQuestion(text)) {
        appendTurn(data, text, [{ role: 'assistant', content: CALLBACK_HOURS_COLON }]);
        saveSession(chatId, LLM_STATE, data);
        return CALLBACK_HOURS_COLON;
      }
      data.chatMode = 'phone_backfill';
      data.postQuotePhase = undefined;
    } else if (phase === 'phone_captured') {
      if (isWhenCallbackQuestion(text)) {
        appendTurn(data, text, [{ role: 'assistant', content: CALLBACK_HOURS_COLON }]);
        saveSession(chatId, LLM_STATE, data);
        return CALLBACK_HOURS_COLON;
      }
      data.chatMode = 'engaged';
      data.postQuotePhase = undefined;
    }
  }

  if (mode === 'engaged' && isWhenCallbackQuestion(text)) {
    appendTurn(data, text, [{ role: 'assistant', content: CALLBACK_HOURS_DASH }]);
    saveSession(chatId, LLM_STATE, data);
    return CALLBACK_HOURS_DASH;
  }

  if (mode === 'engaged' && !history.some((m) => m.role === 'assistant')) {
    appendTurn(data, text, [{ role: 'assistant', content: ENGAGED_REOPEN_PROMPT }]);
    saveSession(chatId, LLM_STATE, data);
    return ENGAGED_REOPEN_PROMPT;
  }

  if (mode === 'estimate_wait') {
    if (isWhenCallbackQuestion(text)) {
      appendTurn(data, text, [{ role: 'assistant', content: CALLBACK_HOURS_COLON }]);
      saveSession(chatId, LLM_STATE, data);
      return CALLBACK_HOURS_COLON;
    }
    appendTurn(data, text, [{ role: 'assistant', content: ESTIMATE_WAITING_REPLY }]);
    saveSession(chatId, LLM_STATE, data);
    return ESTIMATE_WAITING_REPLY;
  }

  if (mode === 'survey_estimate_only' && !hasAnyAssistantHistory(history)) {
    appendTurn(data, text, [{ role: 'assistant', content: ESTIMATE_ONLY_START_PROMPT }]);
    saveSession(chatId, LLM_STATE, data);
    return ESTIMATE_ONLY_START_PROMPT;
  }

  const knownPhoneNorm =
    data.capturedPhone?.trim() ||
    (data.phone?.trim() ? normalizePhone(data.phone) : null) ||
    undefined;

  const currentMode = data.chatMode ?? mode;
  const llmMode: NonNullable<SessionData['chatMode']> =
    currentMode === 'post_quote' ? 'phone_backfill' : currentMode;
  const result = await runLlmTurn(text, history, {
    chatMode: llmMode,
    chatId,
    clientName: data.clientName,
    itemId: data.itemId,
    knownCargo: data.cargo || undefined,
    knownWeight: data.weight || undefined,
    knownVolume: data.volume || undefined,
    knownRoute: data.route || undefined,
    knownPayment: data.paymentMethod || undefined,
    knownPhone: knownPhoneNorm || undefined,
  });

  if (!result) {
    return 'Извините, сейчас не получилось обработать сообщение. Напишите ещё раз чуть позже.';
  }

  appendTurn(data, text, result.newHistoryEntries);

  if (result.sessionEnded) {
    deleteSession(chatId);
    logger.info({ chatId, mode }, 'Conversation completed (tool submit)');
  } else {
    saveSession(chatId, LLM_STATE, data);
  }

  const finalMode = data.chatMode ?? llmMode;
  return enforceNoPhoneInEstimateMode(finalMode, result.reply);
}
