import { normalizePhone } from '../../core/phone.js';
import { logger } from '../../core/logger.js';
import { postSubmitWebhook } from '../../integrations/webhook/submit-lead.js';
import {
  saveClient,
  updateClientPhoneByChatId,
  type SessionData,
} from '../../infrastructure/storage/repository.js';

export interface ToolExecResult {
  ok: boolean;
  /** JSON-строка для role=tool content */
  toolContent: string;
  /** Заявка сохранена локально и уведомлён webhook */
  persisted: boolean;
}

function toolJson(ok: boolean, message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ ok, message, ...extra });
}

export async function executeSubmitTransportLead(
  chatId: string,
  sessionDefaults: Pick<SessionData, 'itemId' | 'clientName'>,
  rawArgs: unknown,
): Promise<ToolExecResult> {
  if (!rawArgs || typeof rawArgs !== 'object') {
    return { ok: false, toolContent: toolJson(false, 'Некорректные аргументы'), persisted: false };
  }
  const a = rawArgs as Record<string, unknown>;
  const cargo = String(a.cargo ?? '').trim();
  const route = String(a.route ?? '').trim();
  const payment_method = String(a.payment_method ?? a.paymentMethod ?? '').trim();
  const phoneRaw = String(a.phone ?? '').trim();
  const client_name = String(a.client_name ?? a.clientName ?? sessionDefaults.clientName ?? '').trim();

  const phone = normalizePhone(phoneRaw);
  if (!cargo || !route || !payment_method || !phone) {
    return {
      ok: false,
      toolContent: toolJson(false, 'Заполните груз, маршрут, оплату и корректный телефон +7…'),
      persisted: false,
    };
  }

  const row: SessionData & { chatId: string } = {
    chatId,
    itemId: sessionDefaults.itemId || '',
    clientName: client_name || sessionDefaults.clientName || '',
    cargo,
    route,
    paymentMethod: payment_method,
    phone,
  };

  saveClient(row);

  const remoteOk = await postSubmitWebhook({
    event: 'transport_lead',
    chat_id: chatId,
    item_id: row.itemId || null,
    client_name: row.clientName || null,
    cargo,
    route,
    payment_method,
    phone,
    submitted_at: new Date().toISOString(),
  });

  if (!remoteOk) {
    logger.warn({ chatId }, 'Local save OK but submit webhook failed');
  }

  logger.info({ chatId }, 'Transport lead saved after tool call');
  return {
    ok: true,
    toolContent: toolJson(true, 'Заявка принята', { webhook_ok: remoteOk }),
    persisted: true,
  };
}

export async function executeSubmitPhoneBackfill(
  chatId: string,
  rawArgs: unknown,
): Promise<ToolExecResult> {
  if (!rawArgs || typeof rawArgs !== 'object') {
    return { ok: false, toolContent: toolJson(false, 'Некорректные аргументы'), persisted: false };
  }
  const phone = normalizePhone(String((rawArgs as { phone?: string }).phone ?? ''));
  if (!phone) {
    return {
      ok: false,
      toolContent: toolJson(false, 'Нужен корректный телефон +7…'),
      persisted: false,
    };
  }

  const updated = updateClientPhoneByChatId(chatId, phone);
  if (!updated) {
    return {
      ok: false,
      toolContent: toolJson(false, 'Не удалось обновить запись'),
      persisted: false,
    };
  }

  const whOk = await postSubmitWebhook({
    event: 'phone_backfill',
    chat_id: chatId,
    item_id: null,
    client_name: null,
    cargo: null,
    route: null,
    payment_method: null,
    phone,
    submitted_at: new Date().toISOString(),
  });
  if (!whOk) {
    logger.warn({ chatId }, 'Phone saved locally but submit webhook failed');
  }

  logger.info({ chatId, phone }, 'Phone backfill saved after tool call');
  return {
    ok: true,
    toolContent: toolJson(true, 'Телефон сохранён'),
    persisted: true,
  };
}
