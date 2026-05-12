import { getClientBotStoppedByChatId } from '../../infrastructure/storage/repository.js';

/** Для этого чата диалог переведён на человека через API: входящие бот не обрабатывает. */
export function isConversationTakenOver(chatId: string): boolean {
  return getClientBotStoppedByChatId(chatId);
}
