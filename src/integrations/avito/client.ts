import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';

const BASE = config.avito.baseUrl;

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

export interface AvitoUser {
  id: number;
  name: string;
  email: string;
}

export interface MessageContent {
  text?: string;
  image?: unknown;
}

export interface AvitoMessage {
  id: string;
  author_id: number;
  chat_id: string;
  created: number;
  type: string;
  content: MessageContent;
}

export interface LastMessage {
  text?: string;
  content?: MessageContent;
}

export interface ChatUser {
  id: number;
  name?: string;
}

export interface ChatContext {
  type?: string;
  value?: {
    id?: string;
    name?: string;
    title?: string;
    /** Прямая ссылка на объявление, если API мессенджера её отдаёт */
    url?: string;
    public_url?: string;
    link?: string;
  };
}

export interface AvitoChat {
  id: string;
  unread_count?: number;
  created?: number;
  last_message?: LastMessage;
  users?: ChatUser[];
  context?: ChatContext;
}

export interface ChatsResponse {
  chats?: AvitoChat[];
  result?: { chats?: AvitoChat[] };
}

export interface MessagesResponse {
  messages?: AvitoMessage[];
  result?: { messages?: AvitoMessage[] };
}

export interface GetChatsParams {
  unread_only?: boolean;
  item_ids?: string;
  limit?: number;
  offset?: number;
}

export interface GetMessagesParams {
  limit?: number;
  offset?: number;
}

const tokenData: { accessToken: string | null; expiresAt: number } = {
  accessToken: null,
  expiresAt: 0,
};

async function fetchJson<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Avito API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export async function getAccessToken(): Promise<string> {
  if (tokenData.accessToken && Date.now() < tokenData.expiresAt) {
    return tokenData.accessToken;
  }

  logger.info('Requesting new access token…');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.avito.clientId,
    client_secret: config.avito.clientSecret,
  });

  const data = await fetchJson<TokenResponse>(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  tokenData.accessToken = data.access_token;
  tokenData.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  logger.info('Access token obtained, expires in %d s', data.expires_in);
  return tokenData.accessToken;
}

export async function resolveUserId(): Promise<string> {
  if (config.avito.userId) return config.avito.userId;
  const headers = await authHeaders();
  const data = await fetchJson<AvitoUser>(`${BASE}/core/v1/accounts/self`, { headers });
  config.avito.userId = String(data.id);
  logger.info('Resolved user_id = %s', config.avito.userId);
  return config.avito.userId;
}

export async function getSelf(): Promise<AvitoUser> {
  const headers = await authHeaders();
  return fetchJson<AvitoUser>(`${BASE}/core/v1/accounts/self`, { headers });
}

export async function getChats(params: GetChatsParams = {}): Promise<ChatsResponse> {
  const userId = await resolveUserId();
  const headers = await authHeaders();
  const qs = new URLSearchParams();
  if (params.unread_only != null) qs.set('unread_only', String(params.unread_only));
  if (params.item_ids) qs.set('item_ids', params.item_ids);
  qs.set('limit', String(params.limit ?? 50));
  qs.set('offset', String(params.offset ?? 0));
  return fetchJson<ChatsResponse>(`${BASE}/messenger/v2/accounts/${userId}/chats?${qs}`, { headers });
}

export async function getChatMessages(
  chatId: string,
  { limit = 50, offset = 0 }: GetMessagesParams = {},
): Promise<MessagesResponse> {
  const userId = await resolveUserId();
  const headers = await authHeaders();
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return fetchJson<MessagesResponse>(
    `${BASE}/messenger/v3/accounts/${userId}/chats/${chatId}/messages/?${qs}`,
    { headers },
  );
}

export async function sendMessage(chatId: string, text: string): Promise<unknown> {
  const userId = await resolveUserId();
  const headers = await authHeaders();
  return fetchJson<unknown>(`${BASE}/messenger/v1/accounts/${userId}/chats/${chatId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: { text }, type: 'text' }),
  });
}

export async function markChatRead(chatId: string): Promise<unknown> {
  const userId = await resolveUserId();
  const headers = await authHeaders();
  return fetchJson<unknown>(`${BASE}/messenger/v1/accounts/${userId}/chats/${chatId}/read`, {
    method: 'POST',
    headers,
  });
}

export async function getChatById(chatId: string): Promise<AvitoChat> {
  const userId = await resolveUserId();
  const headers = await authHeaders();
  return fetchJson<AvitoChat>(`${BASE}/messenger/v2/accounts/${userId}/chats/${chatId}`, { headers });
}

/** Ответ GET /core/v1/accounts/{user_id}/items/{item_id}/ — в т.ч. публичный URL объявления */
export interface ItemInfoAvito {
  status?: string;
  url?: string;
}

/**
 * Публичный URL объявления по item_id (для вашего аккаунта).
 * Нужны права API на «объявления»; иначе вернётся null.
 */
export async function getItemInfo(userId: string, itemId: string): Promise<ItemInfoAvito | null> {
  const headers = await authHeaders();
  const path = `${BASE}/core/v1/accounts/${userId}/items/${encodeURIComponent(itemId)}/`;
  try {
    return await fetchJson<ItemInfoAvito>(path, { headers });
  } catch (err) {
    logger.debug({ err, userId, itemId }, 'getItemInfo: не удалось (нет прав или чужое объявление)');
    return null;
  }
}

export async function subscribeWebhook(webhookUrl: string): Promise<unknown> {
  const headers = await authHeaders();
  return fetchJson<unknown>(`${BASE}/messenger/v3/webhook`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: webhookUrl }),
  });
}
