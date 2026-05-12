import { logger } from '../../core/logger.js';
import type { AvitoChat, AvitoMessage } from '../../integrations/avito/client.js';
import { sendMessage } from '../../integrations/avito/client.js';
import { isConversationTakenOver } from './human-takeover.js';
import { processMessage } from './router.js';

const BATCH_DELAY_MS = 30 * 1000;

type ChatBatch = {
  parts: string[];
  lastMessage: AvitoMessage;
  chat?: AvitoChat;
  timer: ReturnType<typeof setTimeout>;
};

const pendingByChatId = new Map<string, ChatBatch>();

async function flushChatBatch(chatId: string): Promise<void> {
  const batch = pendingByChatId.get(chatId);
  if (!batch) return;
  pendingByChatId.delete(chatId);

  const mergedText = batch.parts.join('\n').trim();
  if (!mergedText) return;

  if (isConversationTakenOver(chatId)) {
    logger.debug({ chatId }, 'Skip batched reply: conversation taken over via API');
    return;
  }

  logger.info(
    { chatId, messagesCount: batch.parts.length, delayMs: BATCH_DELAY_MS },
    'Processing delayed merged incoming messages',
  );

  const reply = await processMessage(mergedText, batch.lastMessage, batch.chat);
  if (!reply) {
    logger.debug({ chatId }, 'No handler matched merged batch');
    return;
  }
  await sendMessage(chatId, reply);
  logger.info({ chatId, reply }, '→ replied from merged batch');
}

export function enqueueIncomingMessage(
  chatId: string,
  text: string,
  message: AvitoMessage,
  chat?: AvitoChat,
): void {
  const current = pendingByChatId.get(chatId);
  if (current) {
    current.parts.push(text);
    current.lastMessage = message;
    current.chat = chat ?? current.chat;
    return;
  }

  const timer = setTimeout(() => {
    void flushChatBatch(chatId).catch((err) => {
      logger.error({ err, chatId }, 'Failed to process delayed message batch');
    });
  }, BATCH_DELAY_MS);

  pendingByChatId.set(chatId, {
    parts: [text],
    lastMessage: message,
    chat,
    timer,
  });
}

export function clearPendingBatchesForTests(): void {
  for (const batch of pendingByChatId.values()) {
    clearTimeout(batch.timer);
  }
  pendingByChatId.clear();
}
