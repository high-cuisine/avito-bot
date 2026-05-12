import { config, validateConfig, validateOpenAiConfig } from './core/config.js';
import { allowlistActive } from './core/allowlist.js';
import { loadKnowledgeFromDisk } from './core/knowledge.js';
import { loadSystemPromptsFromDisk } from './core/prompts.js';
import { logger } from './core/logger.js';
import { getAccessToken, resolveUserId } from './integrations/avito/client.js';

// Side-effect: registers all message handlers
import './application/messaging/handlers.js';

import { startPolling } from './application/messaging/poller.js';
import { startWebhookServer } from './interfaces/http/webhook-server.js';
import { startApiServer } from './interfaces/http/api-server.js';

async function main(): Promise<void> {
  validateConfig();
  validateOpenAiConfig();
  loadSystemPromptsFromDisk();
  loadKnowledgeFromDisk();

  logger.info('=== Avito Messenger Bot ===');
  logger.info('Mode: %s', config.mode);
  if (allowlistActive()) {
    logger.info(
      { chats: config.allowlistChatIds.length, users: config.allowlistUserIds.length },
      'Allowlist ON: only matching chat_id / user_id get replies; others silently ignored',
    );
  }

  // REST API должен слушать порт до OAuth Авито: иначе при зависшем/медленном token-запросе 1С и curl видят Connection reset / нет сервера.
  startApiServer();

  await getAccessToken();
  const userId = await resolveUserId();
  logger.info('Operating as user_id = %s', userId);

  if (config.mode === 'webhook') {
    await startWebhookServer();
  } else {
    startPolling();
  }
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Startup failed');
  process.exit(1);
});
