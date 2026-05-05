import { allowlistActive, shouldProcessSender } from '../../core/allowlist.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import {
  getChats,
  getChatMessages,
  sendMessage,
  markChatRead,
  resolveUserId,
} from '../../integrations/avito/client.js';
import { formatAllowlistRejectLog } from '../../integrations/avito/peer-label.js';
import { getRuntimeMode } from '../../infrastructure/storage/repository.js';
import { processMessage } from './router.js';

const repliedMessages = new Set<string>();
const MAX_CACHE = 10_000;
const BOT_START_TS = Math.floor(Date.now() / 1000);

function trimCache(): void {
  if (repliedMessages.size > MAX_CACHE) {
    const overflow = repliedMessages.size - MAX_CACHE / 2;
    let count = 0;
    for (const id of repliedMessages) {
      if (count++ >= overflow) break;
      repliedMessages.delete(id);
    }
  }
}

async function pollOnce(): Promise<void> {
  const userId = await resolveUserId();
  let data;
  try {
    data = await getChats({ unread_only: true });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch chats');
    return;
  }

  const chats = data.chats ?? data.result?.chats ?? [];
  if (chats.length === 0) return;
  logger.info('Found %d unread chat(s)', chats.length);

  for (const chat of chats) {
    const chatId = chat.id;
    let messages;
    try {
      const msgData = await getChatMessages(chatId, { limit: 20 });
      messages = msgData.messages ?? msgData.result?.messages ?? [];
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to fetch messages');
      continue;
    }

    const incoming = messages.filter(
      (m) =>
        String(m.author_id) !== String(userId) &&
        !repliedMessages.has(m.id) &&
        m.created >= BOT_START_TS,
    );

    for (const msg of incoming) {
      msg.chat_id = msg.chat_id || chatId;
      const text = msg.content?.text ?? '';
      if (!text || text.startsWith('[Системное сообщение]')) continue;

      const runtimeMode = getRuntimeMode();
      if (!shouldProcessSender(runtimeMode, msg.chat_id, msg.author_id)) {
        if (runtimeMode === 'test' && allowlistActive()) {
          logger.warn(
            formatAllowlistRejectLog(chat, msg.author_id, msg.chat_id),
          );
        }
        repliedMessages.add(msg.id);
        continue;
      }

      logger.info({ chatId, msgId: msg.id, text }, '← incoming');
      const reply = await processMessage(text, msg, chat);
      if (!reply) {
        logger.debug({ chatId, msgId: msg.id }, 'No handler matched, skipping');
        repliedMessages.add(msg.id);
        continue;
      }

      try {
        await sendMessage(chatId, reply);
        logger.info({ chatId, reply }, '→ replied');
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send reply');
      }
      repliedMessages.add(msg.id);
    }

    try {
      await markChatRead(chatId);
    } catch {
      // non-critical
    }
  }

  trimCache();
}

export function startPolling(): () => void {
  const intervalMs = config.pollIntervalSec * 1000;
  logger.info('Polling started (every %d s)', config.pollIntervalSec);
  void pollOnce();
  const timer = setInterval(() => void pollOnce(), intervalMs);
  return () => clearInterval(timer);
}
