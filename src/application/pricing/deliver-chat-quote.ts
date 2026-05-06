import { normalizePhone } from '../../core/phone.js';
import { logger } from '../../core/logger.js';
import { sendMessage } from '../../integrations/avito/client.js';
import {
  getChatEstimateById,
  getClientByChatId,
  saveSession,
  type ChatEstimateRecord,
  type SessionData,
} from '../../infrastructure/storage/repository.js';

export interface DeliverQuoteResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

function buildCargoForClient(e: ChatEstimateRecord): string {
  const base = (e.cargo ?? '').trim();
  const det = (e.details ?? '').trim();
  if (det) return base ? `${base}. Дополнительно: ${det}` : det;
  return base || '—';
}

function parsePriceFromBody(body: unknown): string {
  if (typeof body === 'string') return body.trim();
  if (!body || typeof body !== 'object') return '';
  const p = (body as { price?: unknown }).price;
  if (typeof p === 'number' && Number.isFinite(p)) return String(p).trim();
  if (typeof p === 'string') return p.trim();
  return '';
}

/**
 * Отправляет в чат Avito цену и переводит диалог в post_quote
 * для анализа реакции клиента.
 */
export async function deliverQuoteFromChatEstimateId(
  estimateId: number,
  body: unknown,
): Promise<DeliverQuoteResult> {
  const price = parsePriceFromBody(body);
  if (!price) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Укажите непустое поле price (строка или число в JSON)' },
    };
  }

  const estimate = getChatEstimateById(estimateId);
  if (!estimate) {
    return { ok: false, status: 404, body: { error: 'Запись расчёта не найдена' } };
  }

  const chatId = estimate.chatId;
  const existing = getClientByChatId(chatId);
  if (existing?.phone) {
    const norm = normalizePhone(String(existing.phone));
    if (norm) {
      return {
        ok: false,
        status: 409,
        body: { error: 'У этого чата в заявке уже указан телефон' },
      };
    }
  }

  const text = [
    'По вашему запросу готов расчёт стоимости.',
    '',
    `Стоимость перевозки: ${price}`,
  ].join('\n');

  try {
    await sendMessage(chatId, text);
  } catch (err) {
    logger.error({ err, chatId, estimateId }, 'deliver-quote: Avito sendMessage failed');
    return {
      ok: false,
      status: 502,
      body: { error: 'Не удалось отправить сообщение в чат Авито', chat_id: chatId },
    };
  }

  const sessionData: SessionData = {
    itemId: estimate.itemId ?? '',
    clientName: estimate.clientName ?? '',
    cargo: buildCargoForClient(estimate),
    weight: (estimate.weight ?? '').trim(),
    volume: (estimate.volume ?? '').trim(),
    cargoDetails: (estimate.details ?? '').trim() || '',
    route: (estimate.route ?? '').trim() || '—',
    paymentMethod: (estimate.paymentMethod ?? '').trim() || '—',
    phone: '',
  };

  try {
    saveSession(chatId, 'LLM', {
      ...sessionData,
      capturedPhone: undefined,
      llmMessages: [],
      chatMode: 'post_quote',
      postQuotePhase: 'awaiting_sentiment',
    });
  } catch (err) {
    logger.error({ err, chatId, estimateId }, 'deliver-quote: saveClient/deleteSession failed');
    return {
      ok: false,
      status: 500,
      body: {
        error: 'Сообщение отправлено, но не удалось сохранить заявку в БД',
        chat_id: chatId,
      },
    };
  }

  logger.info({ chatId, estimateId }, 'deliver-quote: price sent, waiting for phone before clients save');
  return { ok: true, status: 200, body: { ok: true, chat_id: chatId } };
}
