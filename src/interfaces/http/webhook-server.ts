import express, { Request, Response } from 'express';
import { allowlistActive, isSenderAllowlisted } from '../../core/allowlist.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import {
  sendMessage,
  resolveUserId,
  subscribeWebhook,
  getChatById,
  type AvitoMessage,
} from '../../integrations/avito/client.js';
import { formatAllowlistRejectLog } from '../../integrations/avito/peer-label.js';
import { processMessage } from '../../application/messaging/router.js';

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

    if (!isSenderAllowlisted(chatId, authorId)) {
      if (allowlistActive()) {
        let line = formatAllowlistRejectLog(undefined, authorId, chatId);
        try {
          const ch = await getChatById(chatId);
          line = formatAllowlistRejectLog(ch, authorId, chatId);
        } catch {
          // оставляем строку без имени
        }
        logger.warn(line);
      }
      return;
    }

    logger.info({ chatId, authorId, text }, '← webhook message');

    const reply = await processMessage(text, payload, undefined);
    if (!reply) {
      logger.debug({ chatId }, 'No handler matched');
      return;
    }

    try {
      await sendMessage(chatId, reply);
      logger.info({ chatId, reply }, '→ replied');
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to send reply');
    }
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
