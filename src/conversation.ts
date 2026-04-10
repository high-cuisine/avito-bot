import { logger } from './logger.js';
import { resolveUserId, getChatById, type AvitoChat } from './avito-client.js';
import {
  getSession,
  saveSession,
  deleteSession,
  saveClient,
  type SessionData,
} from './storage.js';

// ─── States ───────────────────────────────────────────────────────────────────

export const State = {
  ASK_CARGO: 'ASK_CARGO',
  ASK_ROUTE: 'ASK_ROUTE',
  ASK_PAYMENT: 'ASK_PAYMENT',
  CONFIRM: 'CONFIRM',
} as const;

type StateValue = (typeof State)[keyof typeof State];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptyData(): SessionData {
  return { itemId: '', clientName: '', cargo: '', route: '', paymentMethod: '' };
}

function formatSummary(d: SessionData): string {
  return [
    'Проверьте данные:\n',
    `1. Имя: ${d.clientName || '—'}`,
    `2. Груз: ${d.cargo || '—'}`,
    `3. Маршрут: ${d.route || '—'}`,
    `4. Оплата: ${d.paymentMethod || '—'}`,
    '\nВсё верно? (Да / Нет)',
  ].join('\n');
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

function isConfirmation(text: string): boolean {
  return /^(да|yes|ок|ладно|верно|подтвержд)/i.test(text.trim());
}

function isRejection(text: string): boolean {
  return /^(нет|no|не\s*верно|неправильно)/i.test(text.trim());
}

// ─── Main handler ─────────────────────────────────────────────────────────────

/**
 * Handle an incoming message within the conversational survey flow.
 * Returns the reply text the bot should send.
 */
export async function handleConversation(
  chatId: string,
  text: string,
  chatContext?: AvitoChat,
): Promise<string> {
  const session = getSession(chatId);

  // ── New conversation ────────────────────────────────────────────────────────
  if (!session) {
    const { clientName, itemId } = await resolveClientInfo(chatId, chatContext);
    const data: SessionData = { ...emptyData(), clientName, itemId };
    saveSession(chatId, State.ASK_CARGO, data);

    const greeting = clientName
      ? `Здравствуйте, ${clientName}!`
      : 'Здравствуйте!';

    return `${greeting} Подскажите, пожалуйста, характер вашего груза (что перевозим, габариты/вес)?`;
  }

  const { state, data } = session;

  // ── Collect cargo ───────────────────────────────────────────────────────────
  if (state === State.ASK_CARGO) {
    data.cargo = text.trim();
    saveSession(chatId, State.ASK_ROUTE, data);
    return 'Спасибо! Укажите маршрут перевозки (откуда — куда):';
  }

  // ── Collect route ───────────────────────────────────────────────────────────
  if (state === State.ASK_ROUTE) {
    data.route = text.trim();
    saveSession(chatId, State.ASK_PAYMENT, data);
    return 'Принято! Какая форма оплаты? (наличные / безналичные / с НДС / без НДС)';
  }

  // ── Collect payment ─────────────────────────────────────────────────────────
  if (state === State.ASK_PAYMENT) {
    data.paymentMethod = text.trim();
    saveSession(chatId, State.CONFIRM, data);
    return formatSummary(data);
  }

  // ── Confirm ─────────────────────────────────────────────────────────────────
  if (state === State.CONFIRM) {
    if (isConfirmation(text)) {
      saveClient({ chatId, ...data });
      deleteSession(chatId);
      logger.info({ chatId, data }, 'Client survey completed');

      const name = data.clientName || 'уважаемый клиент';
      return `Спасибо, ${name}! Ваша заявка принята. Менеджер свяжется с вами в ближайшее время.`;
    }

    if (isRejection(text)) {
      data.cargo = '';
      data.route = '';
      data.paymentMethod = '';
      saveSession(chatId, State.ASK_CARGO, data);
      return 'Хорошо, давайте заново. Какой характер груза?';
    }

    return 'Пожалуйста, ответьте «Да» для подтверждения или «Нет», чтобы заполнить заново.';
  }

  // Fallback (should not happen)
  deleteSession(chatId);
  return 'Произошла ошибка. Давайте начнём сначала — напишите мне.';
}
