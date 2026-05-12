import {
  getChatEstimateBotStoppedByChatId,
  getClientBotStoppedByChatId,
} from '../../infrastructure/storage/repository.js';

/** Диалог переведён на человека через API (заявка с телефоном или расчёт без телефона). */
export function isConversationTakenOver(chatId: string): boolean {
  return getClientBotStoppedByChatId(chatId) || getChatEstimateBotStoppedByChatId(chatId);
}
