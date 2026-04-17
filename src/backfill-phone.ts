import { validateConfig } from './core/config.js';
import { logger } from './core/logger.js';
import { getAccessToken, sendMessage } from './integrations/avito/client.js';
import { getClientsMissingPhone } from './infrastructure/storage/repository.js';

const DEFAULT_LIMIT = 100;

function getLimit(): number {
  const raw = process.env.BACKFILL_LIMIT;
  if (!raw) return DEFAULT_LIMIT;
  const num = parseInt(raw, 10);
  return Number.isFinite(num) && num > 0 ? num : DEFAULT_LIMIT;
}

function isDryRun(): boolean {
  return String(process.env.BACKFILL_DRY_RUN || '').toLowerCase() === 'true';
}

function buildMessage(name: string | null): string {
  const hello = name ? `Здравствуйте, ${name}!` : 'Здравствуйте!';
  return `${hello} Чтобы завершить оформление заявки, отправьте, пожалуйста, ваш контактный номер телефона в формате +7XXXXXXXXXX или 8XXXXXXXXXX. После этого я попрошу подтвердить номер.`;
}

async function main(): Promise<void> {
  validateConfig();
  await getAccessToken();

  const limit = getLimit();
  const dryRun = isDryRun();
  const clients = getClientsMissingPhone(limit);

  logger.info(
    { totalMissingPhone: clients.length, dryRun, limit },
    'Starting phone backfill outreach',
  );

  if (clients.length === 0) {
    logger.info('No clients without phone found');
    return;
  }

  let sent = 0;
  let failed = 0;

  for (const client of clients) {
    const text = buildMessage(client.clientName);

    if (dryRun) {
      logger.info(
        { chatId: client.chatId, clientId: client.id, preview: text },
        'DRY RUN: message not sent',
      );
      continue;
    }

    try {
      await sendMessage(client.chatId, text);
      sent += 1;
      logger.info({ chatId: client.chatId, clientId: client.id }, 'Backfill message sent');
    } catch (err) {
      failed += 1;
      logger.error({ err, chatId: client.chatId, clientId: client.id }, 'Backfill send failed');
    }
  }

  logger.info({ sent, failed }, 'Phone backfill completed');
}

main().catch((err) => {
  logger.fatal({ err }, 'Phone backfill script failed');
  process.exit(1);
});
