import { config } from '../../core/config.js';
import { getKnowledgeBundle } from '../../core/knowledge.js';
import { logger } from '../../core/logger.js';
import type {
  LlmChatMessage,
  LlmToolCall,
  SessionData,
} from '../../infrastructure/storage/repository.js';
import {
  executeDeclarePhoneContactPath,
  executeSubmitChatEstimateRequest,
  executeSubmitPhoneBackfill,
  executeSubmitTransportLead,
} from '../../application/conversation/execute-submit.js';

export interface LlmContext {
  chatMode: NonNullable<SessionData['chatMode']>;
  chatId: string;
  clientName: string;
  itemId: string;
  knownCargo?: string;
  knownWeight?: string;
  knownVolume?: string;
  knownRoute?: string;
  knownPayment?: string;
  /** Телефон уже в заявке (ранний ввод или БД). */
  knownPhone?: string;
}
export type PriceReaction = 'positive' | 'negative' | 'neutral';

export interface LlmTurnResult {
  /** Текст, который уходит клиенту в Avito */
  reply: string;
  /** Фрагменты истории после этого сообщения пользователя (user уже добавляет сервис). */
  newHistoryEntries: LlmChatMessage[];
  /** Сессию можно закрыть (tool успешно сохранил заявку / телефон). */
  sessionEnded: boolean;
}

const TOOL_TRANSPORT = 'submit_transport_lead';
const TOOL_PHONE = 'submit_phone_backfill';
const TOOL_CHAT_ESTIMATE = 'submit_chat_estimate_request';
const TOOL_DECLARE_PHONE_PATH = 'declare_phone_contact_path';

const MAX_STORED_MESSAGES = 40;

function requiredToolByMode(chatMode: LlmContext['chatMode']): string | null {
  if (chatMode === 'survey') return TOOL_TRANSPORT;
  if (chatMode === 'survey_estimate_only') return TOOL_CHAT_ESTIMATE;
  return null;
}

function transportTool() {
  return {
    type: 'function' as const,
    function: {
      name: TOOL_TRANSPORT,
      description:
        'Вызови один раз, когда собраны маршрут, характер груза, вес, объём, оплата и клиент подтвердил сводку. Телефон в аргументах обязателен, только если его ещё нет в заявке (иначе передай тот же номер или пустую строку — сервер подставит сохранённый).',
      parameters: {
        type: 'object',
        properties: {
          cargo: { type: 'string', description: 'Характер груза' },
          weight: { type: 'string', description: 'Вес груза (например: 1200 кг)' },
          volume: { type: 'string', description: 'Объём груза (например: 8 м3)' },
          route: { type: 'string', description: 'Откуда — куда' },
          payment_method: { type: 'string', description: 'Форма оплаты' },
          phone: {
            type: 'string',
            description:
              'Телефон +7…; если номер уже был записан ранее в диалоге — можно дублировать или оставить пустым',
          },
          client_name: { type: 'string', description: 'Имя клиента, если известно' },
        },
        required: ['cargo', 'route', 'weight', 'volume', 'payment_method'],
      },
    },
  };
}

function chatEstimateTool() {
  return {
    type: 'function' as const,
    function: {
      name: TOOL_CHAT_ESTIMATE,
      description:
        'В режиме «расчёт без телефона»: один раз после сводки и явного подтверждения клиента. Сохраняет параметры для расчёта в чате, без полной заявки с телефоном.',
      parameters: {
        type: 'object',
        properties: {
          cargo: { type: 'string', description: 'Характер груза' },
          weight: { type: 'string', description: 'Вес груза (например: 1200 кг)' },
          volume: { type: 'string', description: 'Объём груза (например: 8 м3)' },
          route: { type: 'string', description: 'Откуда — куда' },
          payment_method: { type: 'string', description: 'Форма оплаты' },
          client_name: { type: 'string', description: 'Имя клиента, если известно' },
          details: {
            type: 'string',
            description:
              'Все дополнительные уточнения для расчёта: габариты, даты, особенности погрузки и т.п.',
          },
        },
        required: ['cargo', 'route', 'weight', 'payment_method'],
      },
    },
  };
}

function phoneIntentTool() {
  return {
    type: 'function' as const,
    function: {
      name: TOOL_DECLARE_PHONE_PATH,
      description:
        'Вызови один раз, когда выбор клиента ясен: готов сообщить телефон для перезвона менеджера (true) или не готов и выбирает расчёт по параметрам в чате без телефона на входе (false). До этого только текст.',
      parameters: {
        type: 'object',
        properties: {
          willing_to_share_phone: {
            type: 'boolean',
            description:
              'true — стандартная заявка с телефоном; false — второй сценарий (только параметры для расчёта в чате)',
          },
        },
        required: ['willing_to_share_phone'],
      },
    },
  };
}

function phoneTool() {
  return {
    type: 'function' as const,
    function: {
      name: TOOL_PHONE,
      description:
        'Вызови один раз, когда клиент подтвердил номер телефона для дозаполнения заявки. Передаёт телефон на сервер.',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Подтверждённый телефон +7XXXXXXXXXX' },
        },
        required: ['phone'],
      },
    },
  };
}

function buildTechnicalInstructions(ctx: LlmContext): string {
  const name = ctx.clientName || 'клиент';
  const item = ctx.itemId ? `Объявление Avito (item_id): ${ctx.itemId}.` : '';

  if (ctx.chatMode === 'phone_backfill') {
    return [
      `Ты вежливый ассистент в чате Авито. Клиенту «${name}» уже оформлена заявка.`,
      item,
      `Уже известно: груз — ${ctx.knownCargo || '—'}; вес — ${ctx.knownWeight || '—'}; объём — ${ctx.knownVolume || '—'}; маршрут — ${ctx.knownRoute || '—'}; оплата — ${ctx.knownPayment || '—'}.`,
      'Мягко запроси телефон в РФ (+7… или 8…), переспроси подтверждение.',
      `Когда клиент явно подтвердил номер — вызови инструмент **${TOOL_PHONE}** с полем phone в формате +7XXXXXXXXXX.`,
      'До этого момента общайся обычным текстом в сообщениях (без вызова инструмента).',
      'Общайся только по-русски, коротко.',
    ].join('\n');
  }

  if (ctx.chatMode === 'engaged') {
    return [
      `Ты ассистент в мессенджере Авито. Клиент: «${name}».`,
      item,
      'Телефон клиента уже есть в заявке. Не проси телефон заново и не отправляй шаблон первого приветствия.',
      'Отвечай по сути вопроса клиента и по базе знаний. Коротко и по-русски.',
    ].join('\n');
  }

  if (ctx.chatMode === 'estimate_wait') {
    return [
      `Ты ассистент в мессенджере Авито. Клиент: «${name}».`,
      item,
      'Заявка на расчет уже сохранена и передана на обработку. Не собирай заявку заново.',
      'Сообщи, что как только расчет будет готов, ответ придет в этот чат.',
      'Общайся коротко и только по-русски.',
    ].join('\n');
  }

  if (ctx.chatMode === 'post_quote') {
    return [
      `Ты ассистент в мессенджере Авито. Клиент: «${name}».`,
      item,
      'Клиент получил цену в чате. Не повторяй шаблон первого приветствия.',
      'Если клиент явно готов оставить номер для звонка — мягко собери и подтверди телефон; затем вызови submit_phone_backfill.',
      'Если клиент не готов обсуждать номер — продолжай вежливый диалог по сути.',
      'Общайся только по-русски.',
    ].join('\n');
  }

  if (ctx.chatMode === 'phone_intent') {
    return [
      `Ты ассистент в мессенджере Авито. Клиент: «${name}».`,
      item,
      'Первое сообщение клиенту с приветствием и просьбой телефона **уже отправлено автоматически** (не дублируй его целиком). Дальше веди диалог по ответу клиента.',
      'Уточняй выбор: готов **назвать телефон** для перезвона менеджера **или** **отказывается** — тогда предложи расчёт по параметрам в чате без телефона на входе. Без пустых «чем могу помочь» вместо сути.',
      'Не повторяй длинное вступление и самопрезентацию («Я Анна…») на каждом шаге. После первого хода пиши коротко и по делу.',
      'Если клиент отвечает кратко по контексту (например: «нет», «неа», «не хочу», «в чате», «да в чате», «второй вариант», «без номера») — интерпретируй это как выбор сценария без телефона и действуй дальше, не зацикливай вопрос.',
      'Если клиент **согласен** дать телефон в чате (или прислал номер) — после явного согласия вызови **' +
        TOOL_DECLARE_PHONE_PATH +
        '** с `willing_to_share_phone: true`.',
      'Если **отказывается** от телефона — не дави; предложи расчёт по параметрам в чате без номера на входе; когда явно согласен на этот вариант — вызови **' +
        TOOL_DECLARE_PHONE_PATH +
        '** с `willing_to_share_phone: false`.',
      'Вопрос «Как вам удобнее?» задавай максимум один раз. Если после него ответ неочевидный — один короткий уточняющий вопрос с двумя вариантами, без повтора всего текста.',
      'Пока выбор неясен — только текст, без инструментов.',
      'Общайся только по-русски.',
    ].join('\n');
  }

  if (ctx.chatMode === 'survey_estimate_only') {
    return [
      `Ты ассистент в мессенджере Авито. Клиент: «${name}».`,
      item,
      'Клиент **не** оставляет телефон; ведёшь **второй сценарий**: расчёт по параметрам в чате.',
      '**ЗАПРЕЩЕНО** просить номер телефона — ни разу, ни под каким предлогом. Этот расчёт не требует телефона.',
      'Собери отдельно маршрут, характер груза, вес, объём, форму оплаты, все уточнения в поле **details** (габариты, даты и т.д.); сводка и явное подтверждение.',
      `После подтверждения вызови **${TOOL_CHAT_ESTIMATE}** один раз.`,
      'Не повторяй один и тот же вопрос, если клиент уже дал поле. Переходи только к недостающим параметрам.',
      'До подтверждённой сводки — только текст. Общайся только по-русски.',
    ].join('\n');
  }

  // survey — стандартная заявка с телефоном
  const phoneNote = ctx.knownPhone
    ? `Телефон **уже сохранён** в заявке: ${ctx.knownPhone}. **Не** проси номер заново; в **${TOOL_TRANSPORT}** в поле phone передай тот же номер или оставь пустым — сервер подставит сохранённый. Собери маршрут, характер груза, вес, объём, оплату и сводку.`
    : 'Собери отдельно маршрут, характер груза, вес, объём, оплату и телефон; сводка и явное подтверждение. Телефон в аргументах инструмента — строго +7 и 10 цифр после.';

  return [
    `Ты ассистент в мессенджере Авито. Клиент: «${name}».`,
    item,
    'Клиент в **стандартном** сценарии с телефоном для перезвона менеджера.',
    phoneNote,
    `После подтверждения сводки вызови **${TOOL_TRANSPORT}** один раз.`,
    'До подтверждённой сводки — только текст. Другие инструменты в этом режиме недоступны.',
    'Общайся только по-русски.',
  ].join('\n');
}

function toolsForMode(chatMode: LlmContext['chatMode']) {
  switch (chatMode) {
    case 'phone_backfill':
      return [phoneTool()];
    case 'post_quote':
      return [phoneTool()];
    case 'phone_intent':
      return [phoneIntentTool()];
    case 'survey':
      return [transportTool()];
    case 'survey_estimate_only':
      return [chatEstimateTool()];
    case 'engaged':
    case 'estimate_wait':
      return [];
    default:
      return [phoneIntentTool()];
  }
}

function buildSystemPrompt(ctx: LlmContext): string {
  const knowledge = getKnowledgeBundle().trim();
  const technical = buildTechnicalInstructions(ctx);
  if (!knowledge) return technical;
  return `${knowledge}\n\n---\n\n# Служебные правила диалога и инструменты\n\n${technical}`;
}

function trimHistory(messages: LlmChatMessage[]): LlmChatMessage[] {
  if (messages.length <= MAX_STORED_MESSAGES) return messages;
  return messages.slice(-MAX_STORED_MESSAGES);
}

type ApiMsg = Record<string, unknown>;

function sanitizeToolCalls(raw: unknown): LlmToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: LlmToolCall[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : '';
    const type = r.type === 'function' ? 'function' : null;
    const fn = r.function;
    if (!id || !type || !fn || typeof fn !== 'object') continue;
    const f = fn as Record<string, unknown>;
    const name = typeof f.name === 'string' ? f.name : '';
    if (!name) continue;
    const argsRaw = f.arguments;
    const args =
      typeof argsRaw === 'string'
        ? argsRaw
        : argsRaw === undefined
          ? '{}'
          : (() => {
              try {
                return JSON.stringify(argsRaw);
              } catch {
                return '{}';
              }
            })();
    out.push({
      id,
      type: 'function',
      function: { name, arguments: args },
    });
  }
  return out;
}

function sanitizeStoredHistory(stored: LlmChatMessage[]): LlmChatMessage[] {
  const out: LlmChatMessage[] = [];
  const pendingToolCalls = new Set<string>();
  for (const m of stored) {
    if (!m || typeof m !== 'object') continue;

    if (m.role === 'user') {
      const content = typeof m.content === 'string' ? m.content : '';
      if (content.trim()) out.push({ role: 'user', content });
      continue;
    }

    if (m.role === 'assistant') {
      const content = typeof m.content === 'string' ? m.content : '';
      const toolCalls = sanitizeToolCalls((m as { tool_calls?: unknown }).tool_calls);
      if (toolCalls.length > 0) {
        for (const tc of toolCalls) pendingToolCalls.add(tc.id);
        out.push({
          role: 'assistant',
          content: content.trim() ? content : '',
          tool_calls: toolCalls,
        });
      } else if (content.trim()) {
        out.push({ role: 'assistant', content });
      }
      continue;
    }

    if (m.role === 'tool') {
      const toolCallId = typeof m.tool_call_id === 'string' ? m.tool_call_id : '';
      const content = typeof m.content === 'string' ? m.content : '';
      if (!toolCallId || !pendingToolCalls.has(toolCallId) || !content.trim()) continue;
      pendingToolCalls.delete(toolCallId);
      out.push({ role: 'tool', tool_call_id: toolCallId, content });
    }
  }
  return out;
}

function toApiMessages(stored: LlmChatMessage[]): ApiMsg[] {
  return sanitizeStoredHistory(stored).map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: 'assistant',
        content: m.content?.trim() ? m.content : null,
        tool_calls: m.tool_calls,
      };
    }
    return { role: 'assistant', content: m.content };
  });
}

type ChoiceMessage = {
  role?: string;
  content?: string | null;
  tool_calls?: LlmToolCall[];
};

function parseToolMessage(toolContent: string): string | null {
  try {
    const parsed = JSON.parse(toolContent) as { message?: unknown };
    return typeof parsed.message === 'string' && parsed.message.trim() ? parsed.message : null;
  } catch {
    return null;
  }
}

async function callChatCompletions(body: Record<string, unknown>): Promise<{
  message: ChoiceMessage | null;
  finishReason: string | null;
} | null> {
  const url = `${config.openai.baseUrl}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    logger.error({ err }, 'OpenAI fetch failed');
    return null;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error({ status: res.status, errText: errText.slice(0, 500) }, 'OpenAI API error');
    return null;
  }

  const json = (await res.json()) as {
    choices?: Array<{ finish_reason?: string; message?: ChoiceMessage }>;
  };
  const choice = json.choices?.[0];
  return {
    message: choice?.message ?? null,
    finishReason: choice?.finish_reason ?? null,
  };
}

export async function runLlmTurn(
  userMessage: string,
  history: LlmChatMessage[],
  ctx: LlmContext,
): Promise<LlmTurnResult | null> {
  const system = buildSystemPrompt(ctx);
  const trimmedHistory = trimHistory(history);
  const tools = toolsForMode(ctx.chatMode);

  const baseMessages: ApiMsg[] = [
    { role: 'system', content: system },
    ...toApiMessages(trimmedHistory),
    { role: 'user', content: userMessage },
  ];

  const first = await callChatCompletions({
    model: config.openai.model,
    messages: baseMessages,
    ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    temperature: 0.45,
    max_tokens: 1200,
  });

  if (!first?.message) return null;

  const mustCallTool = requiredToolByMode(ctx.chatMode);
  let msg1 = first.message;

  // Guardrail: in quote/lead collection modes we should not "finish in text only".
  // If auto tool selection skipped the write tool, ask the model to produce it explicitly.
  if (mustCallTool && (!msg1.tool_calls || msg1.tool_calls.length === 0)) {
    const forced = await callChatCompletions({
      model: config.openai.model,
      messages: baseMessages,
      tools,
      tool_choice: 'required',
      temperature: 0.2,
      max_tokens: 1200,
    });
    if (forced?.message) {
      msg1 = forced.message;
    }
  }

  const toolCalls = msg1.tool_calls;

  const newHistoryEntries: LlmChatMessage[] = [];

  if (!toolCalls || toolCalls.length === 0) {
    const raw = (msg1.content ?? '').trim();
    const text =
      mustCallTool
        ? fallbackTextForMode(ctx.chatMode)
        : raw || fallbackTextForMode(ctx.chatMode);
    newHistoryEntries.push({ role: 'assistant', content: text });
    return { reply: text, newHistoryEntries, sessionEnded: false };
  }

  const assistantWithTools: LlmChatMessage = {
    role: 'assistant',
    content: (msg1.content ?? '').trim(),
    tool_calls: toolCalls,
  };
  newHistoryEntries.push(assistantWithTools);

  const followMessages: ApiMsg[] = [...baseMessages, toApiMessages([assistantWithTools])[0]];

  let sessionEnded = false;
  let writeToolAttempted = false;
  let firstWriteToolError: string | null = null;

  for (const tc of toolCalls) {
    if (tc.type !== 'function') continue;
    const name = tc.function?.name;
    let args: unknown;
    try {
      args = JSON.parse(tc.function.arguments || '{}');
    } catch {
      args = {};
    }

    let toolContent: string;
    if (name === TOOL_DECLARE_PHONE_PATH && ctx.chatMode === 'phone_intent') {
      const exec = await executeDeclarePhoneContactPath(ctx.chatId, args);
      toolContent = exec.toolContent;
      logger.info(
        {
          chatId: ctx.chatId,
          tool: name,
          mode: ctx.chatMode,
          args,
          ok: exec.ok,
          persisted: exec.persisted,
        },
        'Tool execution result',
      );
    } else if (name === TOOL_TRANSPORT && ctx.chatMode === 'survey') {
      writeToolAttempted = true;
      const exec = await executeSubmitTransportLead(
        ctx.chatId,
        { itemId: ctx.itemId, clientName: ctx.clientName },
        args,
      );
      toolContent = exec.toolContent;
      logger.info(
        {
          chatId: ctx.chatId,
          tool: name,
          mode: ctx.chatMode,
          args,
          ok: exec.ok,
          persisted: exec.persisted,
        },
        'Lead write attempt',
      );
      if (exec.persisted && exec.ok) sessionEnded = true;
      if (!exec.ok && !firstWriteToolError) {
        firstWriteToolError = parseToolMessage(exec.toolContent);
      }
    } else if (name === TOOL_CHAT_ESTIMATE && ctx.chatMode === 'survey_estimate_only') {
      writeToolAttempted = true;
      const exec = await executeSubmitChatEstimateRequest(
        ctx.chatId,
        { itemId: ctx.itemId, clientName: ctx.clientName },
        args,
      );
      toolContent = exec.toolContent;
      logger.info(
        {
          chatId: ctx.chatId,
          tool: name,
          mode: ctx.chatMode,
          args,
          ok: exec.ok,
          persisted: exec.persisted,
        },
        'Chat-estimate write attempt',
      );
      if (exec.persisted && exec.ok) sessionEnded = true;
      if (!exec.ok && !firstWriteToolError) {
        firstWriteToolError = parseToolMessage(exec.toolContent);
      }
    } else if (name === TOOL_PHONE && ctx.chatMode === 'phone_backfill') {
      writeToolAttempted = true;
      const exec = await executeSubmitPhoneBackfill(ctx.chatId, args);
      toolContent = exec.toolContent;
      logger.info(
        {
          chatId: ctx.chatId,
          tool: name,
          mode: ctx.chatMode,
          args,
          ok: exec.ok,
          persisted: exec.persisted,
        },
        'Phone backfill write attempt',
      );
      if (exec.persisted && exec.ok) sessionEnded = true;
      if (!exec.ok && !firstWriteToolError) {
        firstWriteToolError = parseToolMessage(exec.toolContent);
      }
    } else {
      toolContent = JSON.stringify({
        ok: false,
        message: 'Этот инструмент здесь недоступен.',
      });
    }

    const toolMsg: LlmChatMessage = { role: 'tool', tool_call_id: tc.id, content: toolContent };
    newHistoryEntries.push(toolMsg);
    followMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolContent });
  }

  if (writeToolAttempted && !sessionEnded && firstWriteToolError) {
    logger.warn(
      {
        chatId: ctx.chatId,
        mode: ctx.chatMode,
        error: firstWriteToolError,
      },
      'Write tool failed, asking client for missing data',
    );
  }

  const needsRecoveryPrompt = mustCallTool !== null && !sessionEnded;
  if (mustCallTool && !writeToolAttempted && !sessionEnded) {
    logger.warn(
      {
        chatId: ctx.chatId,
        mode: ctx.chatMode,
        requiredTool: mustCallTool,
      },
      'Required write tool was not executed',
    );
  }
  const recoveryInstruction = needsRecoveryPrompt
    ? {
        role: 'system' as const,
        content:
          `Инструмент сохранения заявки вернул ошибку: ${firstWriteToolError || 'не удалось сохранить данные'}. ` +
          'НЕЛЬЗЯ писать, что данные переданы логисту или сохранены. Коротко попроси недостающие данные и объясни, что нужно уточнить.',
      }
    : null;

  const second = await callChatCompletions({
    model: config.openai.model,
    messages: recoveryInstruction ? [...followMessages, recoveryInstruction] : followMessages,
    temperature: 0.45,
    max_tokens: 600,
  });

  const finalText = (second?.message?.content ?? '').trim();
  if (needsRecoveryPrompt) {
    const safeText = finalText || firstWriteToolError || fallbackTextForMode(ctx.chatMode);
    newHistoryEntries.push({ role: 'assistant', content: safeText });
    return { reply: safeText, newHistoryEntries, sessionEnded: false };
  }
  if (finalText) {
    newHistoryEntries.push({ role: 'assistant', content: finalText });
    return { reply: finalText, newHistoryEntries, sessionEnded };
  }

  const fallback = sessionEnded
    ? 'Спасибо! Данные переданы, с вами свяжется логист.'
    : 'Уточните, пожалуйста, данные ещё раз.';
  newHistoryEntries.push({ role: 'assistant', content: fallback });
  return { reply: fallback, newHistoryEntries, sessionEnded };
}

function fallbackTextForMode(chatMode: LlmContext['chatMode']): string {
  if (chatMode === 'phone_intent') {
    return 'Напишите номер +7… или 8… для перезвона менеджера. Если номер указать не готовы — напишите об этом.';
  }
  if (chatMode === 'survey') {
    return 'Чтобы оформить заявку, пришлите, пожалуйста: маршрут, характер груза, вес, объем, форму оплаты и телефон +7…';
  }
  if (chatMode === 'survey_estimate_only') {
    return 'Чтобы сохранить запрос на расчет, пришлите маршрут, характер груза, вес, объем и форму оплаты.';
  }
  return 'Напишите, пожалуйста, что вас интересует.';
}

export async function classifyPriceReaction(userMessage: string): Promise<PriceReaction> {
  const first = await callChatCompletions({
    model: config.openai.model,
    messages: [
      {
        role: 'system',
        content:
          'Определи реакцию клиента на цену перевозки. Верни строго JSON вида {"reaction":"positive|negative|neutral"} без пояснений.',
      },
      { role: 'user', content: userMessage },
    ],
    temperature: 0,
    max_tokens: 80,
  });

  const text = (first?.message?.content ?? '').trim();
  if (!text) return 'neutral';

  try {
    const parsed = JSON.parse(text) as { reaction?: string };
    if (parsed.reaction === 'positive') return 'positive';
    if (parsed.reaction === 'negative') return 'negative';
    return 'neutral';
  } catch {
    const lowered = text.toLowerCase();
    if (lowered.includes('positive')) return 'positive';
    if (lowered.includes('negative')) return 'negative';
    return 'neutral';
  }
}
