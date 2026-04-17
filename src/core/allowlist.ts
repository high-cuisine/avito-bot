import { config } from './config.js';

/**
 * Разрешён ли ответ бота в этом чате от этого пользователя (Avito).
 *
 * - Оба списка пустые → все разрешены.
 * - Только `allowlistChatIds` → чат `chatId` должен быть в списке.
 * - Только `allowlistUserIds` → `authorId` собеседника должен быть в списке.
 * - Оба непустые → должны выполняться **оба** условия (чат И пользователь).
 *
 * Вне списка бот **молча не отвечает** (ни LLM, ни текста в чат).
 */
export function isSenderAllowlisted(chatId: string, authorId: string | number): boolean {
  const chats = config.allowlistChatIds;
  const users = config.allowlistUserIds;
  if (chats.length === 0 && users.length === 0) return true;

  const author = String(authorId);
  if (chats.length > 0 && users.length > 0) {
    return chats.includes(chatId) && users.includes(author);
  }
  if (chats.length > 0) return chats.includes(chatId);
  return users.includes(author);
}

export function allowlistActive(): boolean {
  return config.allowlistChatIds.length > 0 || config.allowlistUserIds.length > 0;
}
