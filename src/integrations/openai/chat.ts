import { config } from '../../core/config.js';
import { getKnowledgeBundle } from '../../core/knowledge.js';
import { logger } from '../../core/logger.js';
import {
  getBasePrompt,
  getFirstMessagePrompt,
  getWithPhoneScenarioBlock,
  getWithoutPhoneScenarioBlock,
} from '../../core/prompts.js';
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
const PHONE_REQUEST_RE = /(напиш|укаж|пришл|остав(ь|ьте)).{0,50}(номер|телефон)|(номер|телефон).{0,50}(\+7|8\d{10})/i;

function requiredToolByMode(chatMode: LlmContext['chatMode']): string | null {
  if (chatMode === 'survey') return TOOL_TRANSPORT;
  if (chatMode === 'survey_estimate_only') return TOOL_CHAT_ESTIMATE;
  return null;
}

function sanitizeNoPhoneModeReply(chatMode: LlmContext['chatMode'], reply: string): string {
  if (
    (chatMode === 'survey_estimate_only' || chatMode === 'estimate_wait') &&
    PHONE_REQUEST_RE.test(reply)
  ) {
    return 'Принято. В этом сценарии номер телефона не нужен. Продолжаем расчет в чате: уточните недостающие параметры (маршрут, груз, вес, оплата), и я передам заявку логисту.';
  }
  return reply;
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

function joinPromptBlocks(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join('\n\n---\n\n');
}

/**
 * post_quote в сессии; в runLlmTurn передаётся как `phone_backfill` — один сценарий.
 */
function withPhoneSectionKey(
  mode: LlmContext['chatMode'],
): 'survey' | 'phone_backfill' | 'engaged' {
  if (mode === 'survey') return 'survey';
  if (mode === 'phone_backfill' || mode === 'post_quote') return 'phone_backfill';
  if (mode === 'engaged') return 'engaged';
  return 'phone_backfill';
}

function buildWithPhoneContextNote(ctx: LlmContext): string {
  const name = ctx.clientName || 'клиент';
  const item = ctx.itemId ? `Объявление (item_id): ${ctx.itemId}.` : '';
  const m = ctx.chatMode;

  if (m === 'survey') {
    const phoneLine = ctx.knownPhone
      ? `Контакт уже в заявке: ${ctx.knownPhone} — в **${TOOL_TRANSPORT}** в поле \`phone\` передай тот же или оставь пустым, сервер подставит.`
      : `В **${TOOL_TRANSPORT}** поле \`phone\`: строго +7 и 10 цифр после, после явного согласия в чате.`;
    return ['# Контекст (режим: survey)', `Клиент: «${name}».`, item, phoneLine]
      .filter((x) => x)
      .join('\n');
  }

  if (m === 'phone_backfill' || m === 'post_quote') {
    return [
      '# Контекст (режим: phone_backfill — заявка или расчёт в чате, при необходимости дозапрос контакта в чате)',
      `Клиент: «${name}».`,
      item,
      `Уже известно: груз — ${ctx.knownCargo || '—'}; вес — ${ctx.knownWeight || '—'}; объём — ${ctx.knownVolume || '—'}; маршрут — ${ctx.knownRoute || '—'}; оплата — ${ctx.knownPayment || '—'}.`,
      `Когда контакт для связи согласован в чате в формате +7 — вызови **${TOOL_PHONE}** с \`phone\` в формате +7 и 10 цифр после. До подтверждения — только текст.`,
    ]
      .filter((x) => x)
      .join('\n');
  }

  if (m === 'engaged') {
    return [
      '# Контекст (режим: engaged — контакт в заявке, ответы по вопросам / новая перевозка кратко)',
      `Клиент: «${name}».`,
      item,
    ]
      .filter((x) => x)
      .join('\n');
  }

  return [item, `Клиент: «${name}».`].filter((x) => x).join('\n');
}

function buildWithoutPhoneContextNote(ctx: LlmContext): string {
  const name = ctx.clientName || 'клиент';
  const item = ctx.itemId ? `Объявление (item_id): ${ctx.itemId}.` : '';
  if (ctx.chatMode === 'estimate_wait') {
    return [
      '# Контекст (режим: estimate_wait — заявка на расчёт в работе)',
      `Клиент: «${name}».`,
      item,
      'Ответ с оценкой придёт в этот чат, как будет готово. Не начинай с нуля полный опрос, если клиент не просит уточнения/доп. данные.',
    ]
      .filter((x) => x)
      .join('\n');
  }
  return [
    '# Контекст (режим: survey_estimate_only — расчёт в чате, без сбора контакта на входе)',
    `Клиент: «${name}».`,
    item,
  ]
    .filter((x) => x)
    .join('\n');
}

/**
 * Собирает системный промпт из avito/prompts (обособленные блоки) + база знаний, где уместно.
 * Экспортируется для unit-тестов на изоляцию веток.
 */
export function buildSystemPrompt(ctx: LlmContext): string {
  const base = getBasePrompt().trim();
  if (ctx.chatMode === 'phone_intent') {
    return joinPromptBlocks([base, getFirstMessagePrompt().trim()]);
  }
  if (ctx.chatMode === 'survey_estimate_only' || ctx.chatMode === 'estimate_wait') {
    return joinPromptBlocks([base, getWithoutPhoneScenarioBlock(ctx.chatMode), buildWithoutPhoneContextNote(ctx)]);
  }

  const knowledge = getKnowledgeBundle().trim();
  const section = withPhoneSectionKey(ctx.chatMode);
  const scenario = getWithPhoneScenarioBlock(section);
  const note = buildWithPhoneContextNote(ctx);
  if (!knowledge) {
    logger.warn('Knowledge bundle empty; with-phone turn runs without product MD');
    return joinPromptBlocks([base, scenario, note]);
  }
  return joinPromptBlocks([base, knowledge, scenario, note]);
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
    const textRaw =
      mustCallTool
        ? fallbackTextForMode(ctx.chatMode)
        : raw || fallbackTextForMode(ctx.chatMode);
    const text = sanitizeNoPhoneModeReply(ctx.chatMode, textRaw);
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

  // Жесткий ответ для второго сценария:
  // после успешного submit_chat_estimate_request не даем модели второй ход,
  // чтобы она не могла снова попросить телефон до публикации цены в чате.
  if (ctx.chatMode === 'survey_estimate_only' && sessionEnded && !needsRecoveryPrompt) {
    const doneText =
      'Спасибо! Параметры для расчета сохранены. Как только расчет будет готов, мы ответим в этом чате.';
    newHistoryEntries.push({ role: 'assistant', content: doneText });
    return { reply: doneText, newHistoryEntries, sessionEnded: true };
  }

  const second = await callChatCompletions({
    model: config.openai.model,
    messages: recoveryInstruction ? [...followMessages, recoveryInstruction] : followMessages,
    temperature: 0.45,
    max_tokens: 600,
  });

  const finalText = (second?.message?.content ?? '').trim();
  if (needsRecoveryPrompt) {
    const safeTextRaw = finalText || firstWriteToolError || fallbackTextForMode(ctx.chatMode);
    const safeText = sanitizeNoPhoneModeReply(ctx.chatMode, safeTextRaw);
    newHistoryEntries.push({ role: 'assistant', content: safeText });
    return { reply: safeText, newHistoryEntries, sessionEnded: false };
  }
  if (finalText) {
    const sanitized = sanitizeNoPhoneModeReply(ctx.chatMode, finalText);
    newHistoryEntries.push({ role: 'assistant', content: sanitized });
    return { reply: sanitized, newHistoryEntries, sessionEnded };
  }

  const fallbackRaw = sessionEnded
    ? 'Спасибо! Данные переданы, с вами свяжется логист.'
    : 'Уточните, пожалуйста, данные ещё раз.';
  const fallback = sanitizeNoPhoneModeReply(ctx.chatMode, fallbackRaw);
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
