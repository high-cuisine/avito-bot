import { validateConfig } from './core/config.js';
import { logger } from './core/logger.js';
import { getAccessToken, getChatMessages, sliceMessages } from './integrations/avito/client.js';
import {
  getClientsMissingPhone,
  updateClientPhoneByChatId,
  type ClientRecord,
} from './infrastructure/storage/repository.js';

const DEFAULT_LIMIT = 100;
const DEFAULT_SCAN_MESSAGES = 100;

function getLimit(): number {
  const raw = process.env.BACKFILL_LIMIT;
  if (!raw) return DEFAULT_LIMIT;
  const num = parseInt(raw, 10);
  return Number.isFinite(num) && num > 0 ? num : DEFAULT_LIMIT;
}

function getScanMessagesLimit(): number {
  const raw = process.env.BACKFILL_SCAN_MESSAGES;
  if (!raw) return DEFAULT_SCAN_MESSAGES;
  const num = parseInt(raw, 10);
  return Number.isFinite(num) && num > 0 ? num : DEFAULT_SCAN_MESSAGES;
}

function isDryRun(): boolean {
  return String(process.env.BACKFILL_DRY_RUN || '').toLowerCase() === 'true';
}

import { normalizePhoneFromMessage } from './core/phone.js';

async function tryExtractPhone(client: ClientRecord, scanLimit: number): Promise<string | null> {
  try {
    const data = await getChatMessages(client.chatId, { limit: scanLimit, offset: 0 });
    const messages = sliceMessages(data);

    for (const message of messages) {
      const text = message.content?.text ?? '';
      if (!text) continue;
      const phone = normalizePhoneFromMessage(text);
      if (phone) return phone;
    }
  } catch (err) {
    logger.warn({ err, chatId: client.chatId }, 'Failed to read chat history for phone extraction');
  }
  return null;
}

async function main(): Promise<void> {
  validateConfig();
  await getAccessToken();

  const limit = getLimit();
  const scanLimit = getScanMessagesLimit();
  const dryRun = isDryRun();
  const clients = getClientsMissingPhone(limit);

  logger.info(
    { totalMissingPhone: clients.length, dryRun, limit, scanLimit },
    'Starting phone extraction from chat history',
  );

  if (clients.length === 0) {
    logger.info('No clients without phone found');
    return;
  }

  let found = 0;
  let updated = 0;

  for (const client of clients) {
    const phone = await tryExtractPhone(client, scanLimit);
    if (!phone) continue;
    found += 1;

    if (dryRun) {
      logger.info(
        { clientId: client.id, chatId: client.chatId, phone },
        'DRY RUN: phone extracted (not saved)',
      );
      continue;
    }

    const ok = updateClientPhoneByChatId(client.chatId, phone);
    if (ok) {
      updated += 1;
      logger.info({ clientId: client.id, chatId: client.chatId, phone }, 'Phone updated from history');
    }
  }

  logger.info({ found, updated }, 'Phone extraction from history completed');
}

main().catch((err) => {
  logger.fatal({ err }, 'Phone extraction script failed');
  process.exit(1);
});
