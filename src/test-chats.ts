import { validateConfig } from './config.js';
import { logger } from './logger.js';
import {
  getAccessToken,
  resolveUserId,
  getChats,
  getChatMessages,
} from './avito-client.js';

async function main(): Promise<void> {
  validateConfig();
  await getAccessToken();
  const userId = await resolveUserId();

  logger.info('Fetching all chats for user %s…', userId);

  const data = await getChats({ limit: 100 });
  const chats = data.chats ?? data.result?.chats ?? [];

  console.log('\n=== ALL CHATS (%d) ===\n', chats.length);

  for (const chat of chats) {
    const lastMsg =
      chat.last_message?.text ?? chat.last_message?.content?.text ?? '—';
    console.log(
      '  [%s] chat_id=%s  unread=%s  last: %s',
      chat.created ? new Date(chat.created * 1000).toLocaleDateString('ru') : '?',
      chat.id,
      chat.unread_count ?? '?',
      lastMsg.slice(0, 80),
    );
  }

  if (chats.length === 0) {
    console.log('  (no chats found)');
    return;
  }

  const firstChat = chats[0];
  console.log('\n=== MESSAGES from chat %s ===\n', firstChat.id);

  const msgData = await getChatMessages(firstChat.id, { limit: 30 });
  const messages = msgData.messages ?? msgData.result?.messages ?? [];

  for (const m of messages) {
    const author = String(m.author_id) === String(userId) ? 'ME  ' : 'THEM';
    const text = m.content?.text ?? JSON.stringify(m.content);
    const time = m.created
      ? new Date(m.created * 1000).toLocaleString('ru')
      : '?';
    console.log('  [%s] %s: %s', time, author, text);
  }

  if (messages.length === 0) {
    console.log('  (no messages)');
  }
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Script failed');
  process.exit(1);
});
