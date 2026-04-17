import { logger } from '../../core/logger.js';
import {
  resolveUserId,
  getChatById,
  type AvitoChat,
} from '../../integrations/avito/client.js';
import { runLlmTurn } from '../../integrations/openai/chat.js';
import {
  getSession,
  saveSession,
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
    route: '',
    paymentMethod: '',
    phone: '',
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
        chatMode: 'survey',
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
  const mode = data.chatMode ?? 'survey';
  const history: LlmChatMessage[] = data.llmMessages ?? [];

  const result = await runLlmTurn(text, history, {
    chatMode: mode,
    chatId,
    clientName: data.clientName,
    itemId: data.itemId,
    knownCargo: data.cargo || undefined,
    knownRoute: data.route || undefined,
    knownPayment: data.paymentMethod || undefined,
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
