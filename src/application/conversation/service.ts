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
  PHONE_INTENT_OPENING_REPLY,
  POST_QUOTE_NEGATIVE_REPLY,
  POST_QUOTE_PHONE_PROMPT,
  THANKS_CALLBACK_SOON,
  isWhenCallbackQuestion,
} from './copy.js';
import {
  getSession,
  saveSession,
  saveClient,
  deleteSession,
  getClientByChatId,
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

export async function handleConversation(
  chatId: string,
  text: string,
  chatContext?: AvitoChat,
): Promise<string> {
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
      saveClient({
        chatId,
        itemId: data.itemId || '',
        clientName: data.clientName || '',
        cargo: '',
        weight: '',
        volume: '',
        route: '',
        paymentMethod: '',
        phone: earlyPhone,
      });
      const whOk = await postSubmitWebhook({
        event: 'transport_lead',
        chat_id: chatId,
        item_id: data.itemId || null,
        client_name: data.clientName || null,
        cargo: null,
        route: null,
        payment_method: null,
        phone: earlyPhone,
        submitted_at: new Date().toISOString(),
      });
      if (!whOk) {
        logger.warn({ chatId }, 'Early phone: local save OK but submit webhook failed');
      }
      deleteSession(chatId);
      logger.info({ chatId, phone: earlyPhone, webhook_ok: whOk }, 'Phone-only lead completed');
      return THANKS_CALLBACK_SOON;
    }
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

  return result.reply;
}
