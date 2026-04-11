import { logger } from './logger.js';
import { resolveUserId, getChatById, type AvitoChat } from './avito-client.js';
import {
  getSession,
  saveSession,
  deleteSession,
  saveClient,
  getClientByChatId,
  updateClientPhoneByChatId,
  type SessionData,
} from './storage.js';

// ─── States ───────────────────────────────────────────────────────────────────

export const State = {
  ASK_CARGO: 'ASK_CARGO',
  ASK_ROUTE: 'ASK_ROUTE',
  ASK_PAYMENT: 'ASK_PAYMENT',
  ASK_PHONE: 'ASK_PHONE',
  ASK_PHONE_BACKFILL: 'ASK_PHONE_BACKFILL',
  CONFIRM_PHONE_BACKFILL: 'CONFIRM_PHONE_BACKFILL',
  CONFIRM: 'CONFIRM',
} as const;

type StateValue = (typeof State)[keyof typeof State];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function emptyData(): SessionData {
  return {
    itemId: '',
    clientName: '',
    cargo: '',
    route: '',
    paymentMethod: '',
    phone: '',
  };
}

function formatSummary(d: SessionData): string {
  return [
    'Проверьте данные:\n',
    `1. Имя: ${d.clientName || '—'}`,
    `2. Груз: ${d.cargo || '—'}`,
    `3. Маршрут: ${d.route || '—'}`,
    `4. Оплата: ${d.paymentMethod || '—'}`,
    `5. Телефон: ${d.phone || '—'}`,
    '\nВсё верно? (Да / Нет)',
  ].join('\n');
}

function normalizePhone(text: string): string | null {
  const digits = text.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) {
    return `+7${digits.slice(1)}`;
  }
  if (digits.length === 11 && digits.startsWith('7')) {
    return `+${digits}`;
  }
  if (digits.length === 10) {
    return `+7${digits}`;
  }
  return null;
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
  return /^(да|yes|ок|ладно|верно|подтвержд|все\s*верно|всё\s*верно|договорились)/i.test(
    text.trim(),
  );
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
    const existingClient = getClientByChatId(chatId);
    if (existingClient && !existingClient.phone) {
      const data: SessionData = {
        itemId: existingClient.itemId ?? '',
        clientName: existingClient.clientName ?? '',
        cargo: existingClient.cargo ?? '',
        route: existingClient.route ?? '',
        paymentMethod: existingClient.paymentMethod ?? '',
        phone: '',
      };
      saveSession(chatId, State.ASK_PHONE_BACKFILL, data);
      const greeting = data.clientName
        ? `Здравствуйте, ${data.clientName}!`
        : 'Здравствуйте!';
      return `${greeting} Чтобы завершить заявку, укажите, пожалуйста, контактный номер телефона.`;
    }

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
    saveSession(chatId, State.ASK_PHONE, data);
    return 'Укажите, пожалуйста, контактный номер телефона для связи с менеджером.';
  }

  // ── Collect phone ───────────────────────────────────────────────────────────
  if (state === State.ASK_PHONE) {
    const phone = normalizePhone(text);
    if (!phone) {
      return 'Не удалось распознать номер. Отправьте номер в формате +7XXXXXXXXXX или 8XXXXXXXXXX.';
    }
    data.phone = phone;
    saveSession(chatId, State.CONFIRM, data);
    return formatSummary(data);
  }

  // ── Collect phone for old records ───────────────────────────────────────────
  if (state === State.ASK_PHONE_BACKFILL) {
    const phone = normalizePhone(text);
    if (!phone) {
      return 'Не удалось распознать номер. Отправьте номер в формате +7XXXXXXXXXX или 8XXXXXXXXXX.';
    }
    data.phone = phone;
    saveSession(chatId, State.CONFIRM_PHONE_BACKFILL, data);
    return `Подтвердите номер: ${phone}. Всё верно? (Да / Нет)`;
  }

  if (state === State.CONFIRM_PHONE_BACKFILL) {
    if (isConfirmation(text)) {
      updateClientPhoneByChatId(chatId, data.phone);
      deleteSession(chatId);
      const name = data.clientName || 'уважаемый клиент';
      return `Спасибо, ${name}! Номер телефона сохранён.`;
    }
    if (isRejection(text)) {
      data.phone = '';
      saveSession(chatId, State.ASK_PHONE_BACKFILL, data);
      return 'Хорошо, отправьте, пожалуйста, номер ещё раз.';
    }
    return 'Пожалуйста, ответьте «Да» или «Нет».';
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
      data.phone = '';
      saveSession(chatId, State.ASK_CARGO, data);
      return 'Хорошо, давайте заново. Какой характер груза?';
    }

    return 'Пожалуйста, ответьте «Да» для подтверждения или «Нет», чтобы заполнить заново.';
  }

  // Fallback (should not happen)
  deleteSession(chatId);
  return 'Произошла ошибка. Давайте начнём сначала — напишите мне.';
}
