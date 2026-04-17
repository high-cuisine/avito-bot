import type { AvitoChat } from './client.js';

/** Имя собеседника из объекта чата API (если есть). */
export function resolveMessengerPeerName(
  chat: AvitoChat | undefined,
  authorId: string | number,
): string {
  const id = String(authorId);
  const raw = chat?.users?.find((u) => String(u.id) === id)?.name?.trim();
  return raw && raw.length > 0 ? raw : '—';
}

export function formatAllowlistRejectLog(
  chat: AvitoChat | undefined,
  authorId: string | number,
  chatId: string,
): string {
  const name = resolveMessengerPeerName(chat, authorId);
  const uid = String(authorId);
  return `вне allowlist: имя «${name}», user_id=${uid}, chat_id=${chatId}`;
}
