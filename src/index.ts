import { config, validateConfig } from './config.js';
import { logger } from './logger.js';
import { getAccessToken, resolveUserId } from './avito-client.js';

// Side-effect: registers all message handlers
import './handlers.js';

import { startPolling } from './poller.js';
import { startWebhookServer } from './webhook-server.js';
import { startApiServer } from './api-server.js';

async function main(): Promise<void> {
  validateConfig();

  logger.info('=== Avito Messenger Bot ===');
  logger.info('Mode: %s', config.mode);

  await getAccessToken();
  const userId = await resolveUserId();
  logger.info('Operating as user_id = %s', userId);

  // Always start the 1C API server
  startApiServer();

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
