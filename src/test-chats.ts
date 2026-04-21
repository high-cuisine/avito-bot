import { validateConfig } from './core/config.js';
import { logger } from './core/logger.js';
import {
  getAccessToken,
  getSelf,
  getChats,
  getChatMessages,
  getItemInfo,
  type AvitoChat,
} from './integrations/avito/client.js';

/** Ссылка из объекта чата мессенджера (если Avito её кладёт в context). */
function listingUrlFromChatContext(chat: AvitoChat): string | undefined {
  const v = chat.context?.value;
  if (!v) return undefined;
  for (const key of ['url', 'public_url', 'link'] as const) {
    const s = v[key];
    if (typeof s === 'string' && s.startsWith('http')) return s;
  }
  return undefined;
}

function listingTitle(chat: AvitoChat): string {
  const v = chat.context?.value;
  const t = v?.name ?? v?.title;
  return typeof t === 'string' && t.trim() ? t.trim() : '—';
}

async function main(): Promise<void> {
  validateConfig();
  await getAccessToken();

  const self = await getSelf();
  const userId = String(self.id);
  console.log('\n=== АККАУНТ (бот авторизован как) ===');
  console.log(`  user_id : ${userId}`);
  console.log(`  name    : ${self.name}`);
  console.log(`  email   : ${self.email}`);
  console.log(`  профиль : https://www.avito.ru/profile/${userId}`);

  logger.info('Fetching all chats for user %s…', userId);

  const data = await getChats({ limit: 100 });
  const chats = data.chats ?? data.result?.chats ?? [];

  /** item_id → url из Core API (один запрос на уникальный id) */
  const itemUrlCache = new Map<string, string | undefined>();

  async function resolveListingUrl(chat: AvitoChat): Promise<{
    url?: string;
    hint?: string;
  }> {
    const fromCtx = listingUrlFromChatContext(chat);
    if (fromCtx) return { url: fromCtx };

    const itemId = chat.context?.value?.id;
    if (!itemId) {
      return { hint: 'в чате нет context.value.id (например, чат не из объявления)' };
    }

    if (itemUrlCache.has(itemId)) {
      const cached = itemUrlCache.get(itemId);
      return cached
        ? { url: cached }
        : {
            hint: 'GET /core/v1/accounts/.../items/{id}/ не вернул url (нужны права API «Объявления» или объявление не ваше)',
          };
    }

    const info = await getItemInfo(userId, itemId);
    const url = info?.url;
    itemUrlCache.set(itemId, url);
    if (url) return { url };
    return {
      hint: 'публичную ссылку можно взять в ЛК Авито → Мои объявления → «Поделиться», либо включите в приложении API доступ к объявлениям',
    };
  }

  console.log(`\n=== ВСЕ ЧАТЫ (${chats.length}) ===\n`);

  for (const chat of chats) {
    const lastMsg =
      chat.last_message?.text ?? chat.last_message?.content?.text ?? '—';

    const itemId = chat.context?.value?.id ?? '—';
    const title = listingTitle(chat);
    const { url: listingUrl, hint } = await resolveListingUrl(chat);

    const peer = chat.users?.find((u) => String(u.id) !== userId);
    const peerName = peer?.name ?? '—';
    const peerId = peer ? String(peer.id) : '—';

    const date = chat.created
      ? new Date(chat.created * 1000).toLocaleDateString('ru')
      : '?';

    console.log(`  [${date}] chat_id=${chat.id}  unread=${chat.unread_count ?? '?'}`);
    console.log(`           объявление : ${title} (item_id=${itemId})`);
    if (listingUrl) {
      console.log(`           ссылка     : ${listingUrl}`);
    } else {
      console.log(`           ссылка     : (нет) — ${hint ?? '—'}`);
    }
    console.log(`           собеседник : ${peerName}  (user_id=${peerId})`);
    console.log(`           последнее  : ${lastMsg.slice(0, 80)}`);
    console.log('');
  }

  if (chats.length === 0) {
    console.log('  (нет чатов)');
    return;
  }

  const firstChat = chats[0];
  console.log(`=== СООБЩЕНИЯ чата ${firstChat.id} ===\n`);

  const msgData = await getChatMessages(firstChat.id, { limit: 30 });
  const messages = msgData.messages ?? msgData.result?.messages ?? [];

  for (const m of messages) {
    const who = String(m.author_id) === userId ? 'ME  ' : 'THEM';
    const text = m.content?.text ?? JSON.stringify(m.content);
    const time = m.created
      ? new Date(m.created * 1000).toLocaleString('ru')
      : '?';
    console.log(`  [${time}] ${who} author_id=${m.author_id}: ${text}`);
  }

  if (messages.length === 0) {
    console.log('  (нет сообщений)');
  }

  console.log('\n(Для ALLOWLIST_USER_IDS — author_id у строк THEM.)\n');
  console.log(
    'Примечание: путь /items/{id} на сайте часто даёт 404; рабочий URL приходит из API объявлений (поле url) или из context чата.\n',
  );
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Script failed');
  process.exit(1);
});
