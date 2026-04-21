import { config } from '../../core/config.js';
import { getKnowledgeBundle } from '../../core/knowledge.js';
import { logger } from '../../core/logger.js';
import type { LlmChatMessage, LlmToolCall } from '../../infrastructure/storage/repository.js';
import {
  executeSubmitChatEstimateRequest,
  executeSubmitPhoneBackfill,
  executeSubmitTransportLead,
} from '../../application/conversation/execute-submit.js';

export interface LlmContext {
  chatMode: 'survey' | 'phone_backfill';
  chatId: string;
  clientName: string;
  itemId: string;
  knownCargo?: string;
  knownRoute?: string;
  knownPayment?: string;
}

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

const MAX_STORED_MESSAGES = 40;

function transportTool() {
  return {
    type: 'function' as const,
    function: {
      name: TOOL_TRANSPORT,
      description:
        'Вызови один раз, когда по скрипту собраны груз, маршрут, оплата, телефон и клиент явно подтвердил сводку. Передаёт заявку на сервер компании.',
      parameters: {
        type: 'object',
        properties: {
          cargo: { type: 'string', description: 'Характер груза и при необходимости вес' },
          route: { type: 'string', description: 'Откуда — куда' },
          payment_method: { type: 'string', description: 'Форма оплаты' },
          phone: { type: 'string', description: 'Телефон в формате +7XXXXXXXXXX' },
          client_name: { type: 'string', description: 'Имя клиента, если известно' },
        },
        required: ['cargo', 'route', 'payment_method', 'phone'],
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
        'Вызови один раз, когда клиент отказывается давать телефон, но согласен оставить данные для расчёта стоимости в чате: после сводки и явного подтверждения. Не создаёт полную заявку с телефоном — только параметры для расчёта.',
      parameters: {
        type: 'object',
        properties: {
          cargo: { type: 'string', description: 'Характер груза и при необходимости вес' },
          route: { type: 'string', description: 'Откуда — куда' },
          payment_method: { type: 'string', description: 'Форма оплаты' },
          client_name: { type: 'string', description: 'Имя клиента, если известно' },
          details: {
            type: 'string',
            description:
              'Все дополнительные уточнения для расчёта: габариты, даты, особенности погрузки и т.п.',
          },
        },
        required: ['cargo', 'route', 'payment_method'],
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
      `Уже известно: груз — ${ctx.knownCargo || '—'}; маршрут — ${ctx.knownRoute || '—'}; оплата — ${ctx.knownPayment || '—'}.`,
      'Мягко запроси телефон в РФ (+7… или 8…), переспроси подтверждение.',
      `Когда клиент явно подтвердил номер — вызови инструмент **${TOOL_PHONE}** с полем phone в формате +7XXXXXXXXXX.`,
      'До этого момента общайся обычным текстом в сообщениях (без вызова инструмента).',
      'Общайся только по-русски, коротко.',
    ].join('\n');
  }

  return [
    `Ты ассистент в мессенджере Авито. Клиент: «${name}».`,
    item,
    'Веди диалог по скрипту из базы знаний (Анна, грузоперевозки, сбор данных для расчёта, без вопроса «новый или действующий заказ»).',
    'Обычный путь: собери характер груза и по возможности вес, маршрут, форму оплаты, телефон; сводка и явное подтверждение — затем инструмент **' +
      TOOL_TRANSPORT +
      '** (телефон в аргументах строго +7 и 10 цифр после).',
    'Если клиент **категорически не даёт телефон**, но готов оставить параметры для расчёта без звонка — собери маршрут, груз/вес, оплату и все уточнения в поле **details** инструмента **' +
      TOOL_CHAT_ESTIMATE +
      '** после сводки и явного подтверждения. Этот путь **без** телефона; **не** вызывай **' +
      TOOL_TRANSPORT +
      '** без номера.',
    'Выбери **ровно один** подходящий инструмент после подтверждения сводки; до этого отвечай только текстом (не вызывай инструменты раньше времени).',
    'Общайся только по-русски.',
  ].join('\n');
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

function toApiMessages(stored: LlmChatMessage[]): ApiMsg[] {
  return stored.map((m) => {
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
  const tools =
    ctx.chatMode === 'phone_backfill'
      ? [phoneTool()]
      : [transportTool(), chatEstimateTool()];

  const baseMessages: ApiMsg[] = [
    { role: 'system', content: system },
    ...toApiMessages(trimmedHistory),
    { role: 'user', content: userMessage },
  ];

  const first = await callChatCompletions({
    model: config.openai.model,
    messages: baseMessages,
    tools,
    tool_choice: 'auto',
    temperature: 0.45,
    max_tokens: 1200,
  });

  if (!first?.message) return null;

  const msg1 = first.message;
  const toolCalls = msg1.tool_calls;

  const newHistoryEntries: LlmChatMessage[] = [];

  if (!toolCalls || toolCalls.length === 0) {
    const text = (msg1.content ?? '').trim() || 'Напишите, пожалуйста, что вас интересует.';
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
    if (name === TOOL_TRANSPORT && ctx.chatMode === 'survey') {
      const exec = await executeSubmitTransportLead(
        ctx.chatId,
        { itemId: ctx.itemId, clientName: ctx.clientName },
        args,
      );
      toolContent = exec.toolContent;
      if (exec.persisted && exec.ok) sessionEnded = true;
    } else if (name === TOOL_CHAT_ESTIMATE && ctx.chatMode === 'survey') {
      const exec = await executeSubmitChatEstimateRequest(
        ctx.chatId,
        { itemId: ctx.itemId, clientName: ctx.clientName },
        args,
      );
      toolContent = exec.toolContent;
      if (exec.persisted && exec.ok) sessionEnded = true;
    } else if (name === TOOL_PHONE && ctx.chatMode === 'phone_backfill') {
      const exec = await executeSubmitPhoneBackfill(ctx.chatId, args);
      toolContent = exec.toolContent;
      if (exec.persisted && exec.ok) sessionEnded = true;
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

  const second = await callChatCompletions({
    model: config.openai.model,
    messages: followMessages,
    temperature: 0.45,
    max_tokens: 600,
  });

  const finalText = (second?.message?.content ?? '').trim();
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
