import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';

export type SubmitEvent = 'transport_lead' | 'phone_backfill';

export interface TransportLeadPayload {
  event: SubmitEvent;
  chat_id: string;
  item_id: string | null;
  client_name: string | null;
  cargo: string | null;
  route: string | null;
  payment_method: string | null;
  phone: string | null;
  submitted_at: string;
}

export async function postSubmitWebhook(payload: TransportLeadPayload): Promise<boolean> {
  const url = config.submitWebhookUrl;
  if (!url) {
    logger.debug({ event: payload.event }, 'SUBMIT_WEBHOOK_URL not set, skip remote POST');
    return true;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (config.submitWebhookSecret) {
    headers.Authorization = `Bearer ${config.submitWebhookSecret}`;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      logger.error({ status: res.status, body: t.slice(0, 400) }, 'Submit webhook HTTP error');
      return false;
    }
    logger.info({ event: payload.event, chatId: payload.chat_id }, 'Submit webhook OK');
    return true;
  } catch (err) {
    logger.error({ err }, 'Submit webhook fetch failed');
    return false;
  }
}
