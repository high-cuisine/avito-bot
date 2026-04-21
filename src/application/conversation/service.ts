import { normalizePhone } from '../../core/phone.js';
import { logger } from '../../core/logger.js';
import {
  resolveUserId,
  getChatById,
  type AvitoChat,
} from '../../integrations/avito/client.js';
import { runLlmTurn } from '../../integrations/openai/chat.js';
import { postSubmitWebhook } from '../../integrations/webhook/submit-lead.js';
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

/** Первый ответ в режиме phone_intent — только из кода, без LLM (жёсткая просьба телефона). */
const PHONE_INTENT_OPENING_REPLY =
  'Да, добрый день! Грузоперевозки, меня зовут Анна. Напишите, пожалуйста, ваш номер телефона в формате +7… или 8…, чтобы менеджер перезвонил с расчётом стоимости перевозки.';

const THANKS_PHONE_DONE =
  'Спасибо! Номер записали — менеджер перезвонит вам для расчёта и согласования. Дополнительно в чате ничего указывать не нужно.';

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
        route: existingClient.route ?? '',
        paymentMethod: existingClient.paymentMethod ?? '',
        phone: '',
        chatMode: 'phone_backfill',
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
      return THANKS_PHONE_DONE;
    }
  }

  const knownPhoneNorm =
    data.capturedPhone?.trim() ||
    (data.phone?.trim() ? normalizePhone(data.phone) : null) ||
    undefined;

  const result = await runLlmTurn(text, history, {
    chatMode: mode,
    chatId,
    clientName: data.clientName,
    itemId: data.itemId,
    knownCargo: data.cargo || undefined,
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
