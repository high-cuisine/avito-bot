import express, { Request, Response } from 'express';
import { shouldProcessSender } from '../../core/allowlist.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import {
  resolveUserId,
  subscribeWebhook,
  getChatById,
  type AvitoMessage,
} from '../../integrations/avito/client.js';
import { formatAllowlistRejectLog, resolveMessengerPeerName } from '../../integrations/avito/peer-label.js';
import { enqueueIncomingMessage } from '../../application/messaging/batched-dispatcher.js';
import { isConversationTakenOver } from '../../application/messaging/human-takeover.js';
import { getRuntimeMode } from '../../infrastructure/storage/repository.js';

interface WebhookPayload {
  value?: AvitoMessage & { chat_id: string };
}

interface WebhookBody {
  payload?: WebhookPayload;
}

export async function startWebhookServer(): Promise<void> {
  const app = express();
  app.use(express.json());

  const userId = await resolveUserId();

  app.post('/avito/webhook', async (req: Request<object, object, WebhookBody>, res: Response) => {
    res.sendStatus(200);

    const payload = req.body?.payload?.value;
    if (!payload) return;

    const authorId = String(payload.author_id);
    if (authorId === String(userId)) return;

    const chatId = payload.chat_id;
    const text = payload.content?.text ?? '';
    if (!text) return;

    const runtimeMode = getRuntimeMode();

    if (isConversationTakenOver(chatId)) {
      logger.debug({ chatId, authorId }, 'webhook skipped: conversation taken over via API');
      return;
    }

    if (!shouldProcessSender(runtimeMode, chatId, authorId)) {
      if (runtimeMode === 'test') {
        let peerName = '—';
        let line = formatAllowlistRejectLog(undefined, authorId, chatId);
        try {
          const ch = await getChatById(chatId);
          peerName = resolveMessengerPeerName(ch, authorId);
          line = formatAllowlistRejectLog(ch, authorId, chatId);
        } catch {
          // оставляем строку без имени
        }
        logger.warn({ peerName, userId: authorId, chatId }, line);
      }
      return;
    }

    logger.info({ chatId, authorId, text }, '← webhook message');
    enqueueIncomingMessage(chatId, text, payload, undefined);
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  const port = config.webhook.port;
  app.listen(port, () => {
    logger.info('Webhook server listening on port %d', port);
  });

  if (config.webhook.url) {
    try {
      await subscribeWebhook(config.webhook.url);
      logger.info('Webhook subscribed: %s', config.webhook.url);
    } catch (err) {
      logger.error({ err }, 'Failed to subscribe webhook — register it manually');
    }
  } else {
    logger.warn(
      'WEBHOOK_URL not set. Register webhook manually via Avito API pointing to /avito/webhook',
    );
  }
}
