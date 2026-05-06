import { validateChatEstimateFields } from '../../core/chat-estimate-validation.js';
import { normalizePhone } from '../../core/phone.js';
import { logger } from '../../core/logger.js';
import { postSubmitWebhook } from '../../integrations/webhook/submit-lead.js';
import {
  getChatEstimateByChatId,
  getClientByChatId,
  getSession,
  saveClient,
  saveSession,
  updateClientPhoneByChatId,
  upsertChatEstimateRequest,
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

export async function executeDeclarePhoneContactPath(
  chatId: string,
  rawArgs: unknown,
): Promise<ToolExecResult> {
  if (!rawArgs || typeof rawArgs !== 'object') {
    return { ok: false, toolContent: toolJson(false, 'Некорректные аргументы'), persisted: false };
  }
  const a = rawArgs as Record<string, unknown>;
  const v = a.willing_to_share_phone ?? a.willingToSharePhone;
  if (typeof v !== 'boolean') {
    return {
      ok: false,
      toolContent: toolJson(false, 'Нужен boolean willing_to_share_phone'),
      persisted: false,
    };
  }

  const session = getSession(chatId);
  if (!session) {
    return {
      ok: false,
      toolContent: toolJson(false, 'Сессия не найдена'),
      persisted: false,
    };
  }

  const nextMode: SessionData['chatMode'] = v ? 'survey' : 'survey_estimate_only';
  const data: SessionData = { ...session.data, chatMode: nextMode };
  saveSession(chatId, session.state, data);

  const hint = v
    ? 'Дальше соберите маршрут, характер груза, вес, объём, оплату и сводку. Если номер уже прислали ранее — он в заявке; при submit_transport_lead телефон подставится из сохранённого.'
    : 'Режим изменён: расчёт без телефона. ЗАПРЕЩЕНО просить номер телефона — ни разу. Сразу начни собирать параметры: маршрут, характер груза, вес, объём, форма оплаты, уточнения в details. Затем submit_chat_estimate_request.';

  logger.info({ chatId, nextMode }, 'Contact path chosen after phone intent');
  return {
    ok: true,
    toolContent: toolJson(true, hint, { next_mode: nextMode }),
    persisted: true,
  };
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
  const weight = String(a.weight ?? '').trim();
  const volume = String(a.volume ?? '').trim();
  const payment_method = String(a.payment_method ?? a.paymentMethod ?? '').trim();
  const phoneRaw = String(a.phone ?? '').trim();
  const client_name = String(a.client_name ?? a.clientName ?? sessionDefaults.clientName ?? '').trim();

  let phone = normalizePhone(phoneRaw);
  if (!phone) {
    const sess = getSession(chatId);
    const fromSession = sess?.data.capturedPhone?.trim() || sess?.data.phone?.trim();
    if (fromSession) phone = normalizePhone(fromSession);
  }
  if (!cargo || !route || !weight || !volume || !payment_method || !phone) {
    return {
      ok: false,
      toolContent: toolJson(
        false,
        'Заполните маршрут, характер груза, вес, объём, оплату и корректный телефон +7…',
      ),
      persisted: false,
    };
  }

  const row: SessionData & { chatId: string } = {
    chatId,
    itemId: sessionDefaults.itemId || '',
    clientName: client_name || sessionDefaults.clientName || '',
    cargo,
    weight,
    volume,
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
    weight: weight || null,
    volume: volume || null,
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

export async function executeSubmitChatEstimateRequest(
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
  const weight = String(a.weight ?? '').trim();
  const volumeRaw = String(a.volume ?? '').trim();
  const volume = volumeRaw || 'Не указан';
  const payment_method = String(a.payment_method ?? a.paymentMethod ?? '').trim();
  const client_name = String(a.client_name ?? a.clientName ?? sessionDefaults.clientName ?? '').trim();
  const detailsRaw = a.details ?? a.extra_details;
  const details =
    detailsRaw !== undefined && detailsRaw !== null ? String(detailsRaw).trim() || null : null;

  const validation = validateChatEstimateFields({ route, cargo, weight, payment_method });
  if (!validation.ok) {
    return {
      ok: false,
      toolContent: toolJson(false, validation.message, {
        missing: validation.missing,
        vague: validation.vague,
      }),
      persisted: false,
    };
  }

  upsertChatEstimateRequest({
    chatId,
    itemId: sessionDefaults.itemId || '',
    clientName: client_name || sessionDefaults.clientName || '',
    cargo,
    weight,
    volume,
    route,
    paymentMethod: payment_method,
    details,
  });

  const remoteOk = await postSubmitWebhook({
    event: 'chat_estimate',
    chat_id: chatId,
    item_id: sessionDefaults.itemId || null,
    client_name: client_name || sessionDefaults.clientName || null,
    cargo,
    weight: weight || null,
    volume: volume || null,
    route,
    payment_method,
    phone: null,
    details,
    submitted_at: new Date().toISOString(),
  });

  if (!remoteOk) {
    logger.warn({ chatId }, 'Chat estimate saved locally but submit webhook failed');
  }

  logger.info({ chatId }, 'Chat estimate request saved after tool call');
  return {
    ok: true,
    toolContent: toolJson(true, 'Параметры для расчёта сохранены', { webhook_ok: remoteOk }),
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

  const existing = getClientByChatId(chatId);
  if (existing) {
    const updated = updateClientPhoneByChatId(chatId, phone);
    if (!updated) {
      return {
        ok: false,
        toolContent: toolJson(false, 'Не удалось обновить запись'),
        persisted: false,
      };
    }
  } else {
    const session = getSession(chatId);
    const fromEstimate = getChatEstimateByChatId(chatId);
    if (!session && !fromEstimate) {
      return {
        ok: false,
        toolContent: toolJson(false, 'Не удалось найти данные чата для сохранения телефона'),
        persisted: false,
      };
    }
    const row: SessionData & { chatId: string } = {
      chatId,
      itemId: session?.data.itemId || fromEstimate?.itemId || '',
      clientName: session?.data.clientName || fromEstimate?.clientName || '',
      cargo: session?.data.cargo || fromEstimate?.cargo || '',
      weight: session?.data.weight || fromEstimate?.weight || '',
      volume: session?.data.volume || fromEstimate?.volume || '',
      cargoDetails: session?.data.cargoDetails || fromEstimate?.details || '',
      route: session?.data.route || fromEstimate?.route || '',
      paymentMethod: session?.data.paymentMethod || fromEstimate?.paymentMethod || '',
      phone,
    };
    saveClient(row);
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
