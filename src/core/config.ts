import 'dotenv/config';
import path from 'node:path';

export interface AvitoConfig {
  clientId: string;
  clientSecret: string;
  userId: string | null;
  baseUrl: string;
}

export interface OpenAiConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

function parseIdList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Config {
  avito: AvitoConfig;
  mode: 'polling' | 'webhook';
  pollIntervalSec: number;
  webhook: {
    port: number;
    url: string;
  };
  api: {
    port: number;
    token: string;
  };
  openai: OpenAiConfig;
  /** Каталог с `.md` файлами базы знаний (роль, товар, политики). */
  knowledgeDir: string;
  /**
   * Если задан хотя бы один список — бот отвечает только подходящим чатам/пользователям.
   * ID через запятую. Пусто с обеих сторон — без ограничения (как раньше).
   */
  allowlistChatIds: string[];
  allowlistUserIds: string[];
  /** POST JSON заявки после вызова tool моделью (опционально). */
  submitWebhookUrl: string;
  /** Bearer для SUBMIT_WEBHOOK_URL (опционально). */
  submitWebhookSecret: string;
}

export const config: Config = {
  avito: {
    clientId: process.env.AVITO_CLIENT_ID ?? '',
    clientSecret: process.env.AVITO_CLIENT_SECRET ?? '',
    userId: process.env.AVITO_USER_ID || null,
    baseUrl: 'https://api.avito.ru',
  },
  mode: (process.env.MODE as Config['mode']) || 'polling',
  pollIntervalSec: parseInt(process.env.POLL_INTERVAL_SEC ?? '15', 10),
  webhook: {
    port: parseInt(process.env.WEBHOOK_PORT ?? '3000', 10),
    url: process.env.WEBHOOK_URL ?? '',
  },
  api: {
    port: parseInt(process.env.API_PORT ?? '3001', 10),
    token: process.env.API_TOKEN ?? '',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    baseUrl: (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
  },
  knowledgeDir: path.resolve(process.env.KNOWLEDGE_DIR ?? path.join(process.cwd(), 'knowledge')),
  allowlistChatIds: parseIdList(process.env.ALLOWLIST_CHAT_IDS),
  allowlistUserIds: parseIdList(process.env.ALLOWLIST_USER_IDS),
  submitWebhookUrl: (process.env.SUBMIT_WEBHOOK_URL ?? '').trim(),
  submitWebhookSecret: (process.env.SUBMIT_WEBHOOK_SECRET ?? '').trim(),
};

export function validateConfig(): void {
  if (!config.avito.clientId || !config.avito.clientSecret) {
    throw new Error('AVITO_CLIENT_ID and AVITO_CLIENT_SECRET must be set in .env');
  }
}

/** Нужен для основного бота (LLM-диалог); скрипты backfill могут обходиться без OpenAI. */
export function validateOpenAiConfig(): void {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY must be set in .env for the messenger bot');
  }
}
