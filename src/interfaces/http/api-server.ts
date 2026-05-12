import express, { Request, Response, NextFunction } from 'express';
import swaggerUi from 'swagger-ui-express';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { deliverQuoteFromChatEstimateId } from '../../application/pricing/deliver-chat-quote.js';
import {
  getClients,
  getClientById,
  getClientsSince,
  deleteClient,
  getChatEstimates,
  getChatEstimateById,
  getChatEstimatesSince,
  deleteChatEstimateRequest,
  getRuntimeMode,
  setRuntimeMode,
  setChatEstimateTakenOverViaApi,
  setClientTakenOverViaApi,
} from '../../infrastructure/storage/repository.js';
import { attachAdminPanel } from './admin-panel.js';
import type { AvitoMessage } from '../../integrations/avito/client.js';
import { getChatMessagesAll, resolveUserId, sendMessage } from '../../integrations/avito/client.js';

interface DialogMessageDto {
  /** Unix timestamp (как отдаёт Авито) */
  created: number;
  /** Входящее от клиента / исходящее от нашего аккаунта Авито */
  direction: 'in' | 'out';
  text: string;
}

async function dialogFromAvitoMessages(messages: AvitoMessage[]): Promise<DialogMessageDto[]> {
  const selfId = Number.parseInt(await resolveUserId(), 10);
  return messages.map((msg) => {
    const explicit = msg.direction;
    let direction: 'in' | 'out';
    if (explicit === 'in' || explicit === 'out') {
      direction = explicit;
    } else if (!Number.isNaN(selfId) && msg.author_id === selfId) {
      direction = 'out';
    } else {
      direction = 'in';
    }
    return {
      created: msg.created,
      direction,
      text: msg.content?.text ?? '',
    };
  });
}

// ─── OpenAPI spec ─────────────────────────────────────────────────────────────

const swaggerDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Avito Bot — API для 1С',
    version: '1.0.0',
    description:
      'REST API для выгрузки заявок клиентов и запросов расчёта без телефона, собранных ботом Авито, в 1С или любую внешнюю систему.',
    contact: { name: 'Поддержка', email: '' },
  },
  servers: [{ url: '/api/v1', description: 'Основной сервер' }],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Token',
        description: 'Укажите токен из переменной окружения API_TOKEN.',
      },
    },
    schemas: {
      Client: {
        type: 'object',
        properties: {
          id: {
            type: 'integer',
            description: 'Внутренний ID записи',
            example: 1,
          },
          chatId: {
            type: 'string',
            description: 'ID чата в Авито',
            example: 'u2i-abc123',
          },
          itemId: {
            type: 'string',
            nullable: true,
            description: 'ID объявления в Авито',
            example: '3729834762',
          },
          clientName: {
            type: 'string',
            nullable: true,
            description: 'Имя клиента (из профиля Авито)',
            example: 'Иван Петров',
          },
          cargo: {
            type: 'string',
            nullable: true,
            description: 'Характер груза',
            example: 'Два куба коробок, детский питбайк',
          },
          weight: {
            type: 'string',
            nullable: true,
            description: 'Вес груза',
            example: '1200 кг',
          },
          volume: {
            type: 'string',
            nullable: true,
            description: 'Объём груза',
            example: '8 м3',
          },
          cargoDetails: {
            type: 'string',
            nullable: true,
            description: 'Характеристики груза (габариты, вес, доп.условия)',
            example: 'Вес до 5 т, погрузка с пандуса, длина 6 м',
          },
          route: {
            type: 'string',
            nullable: true,
            description: 'Маршрут перевозки',
            example: 'Темрюк — Омск',
          },
          paymentMethod: {
            type: 'string',
            nullable: true,
            description: 'Форма оплаты',
            example: 'Наличные',
          },
          phone: {
            type: 'string',
            nullable: true,
            description: 'Телефон клиента в нормализованном формате',
            example: '+79161234567',
          },
          botStopped: {
            type: 'boolean',
            description:
              'Если true — уже отправляли сообщение через этот REST API; автоматический бот в этом чате клиенту не отвечает.',
            example: false,
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
            description: 'Дата и время создания заявки (UTC)',
            example: '2026-04-10 12:34:56',
          },
        },
        required: ['id', 'chatId', 'createdAt'],
      },
      ClientList: {
        type: 'object',
        properties: {
          total: { type: 'integer', description: 'Количество записей в ответе', example: 5 },
          items: {
            type: 'array',
            items: { $ref: '#/components/schemas/Client' },
          },
        },
        required: ['total', 'items'],
      },
      ChatEstimate: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'Внутренний ID записи', example: 1 },
          chatId: { type: 'string', description: 'ID чата в Авито', example: 'u2i-abc123' },
          itemId: {
            type: 'string',
            nullable: true,
            description: 'ID объявления в Авито',
            example: '3729834762',
          },
          clientName: {
            type: 'string',
            nullable: true,
            description: 'Имя клиента (из профиля Авито)',
            example: 'Иван Петров',
          },
          cargo: {
            type: 'string',
            nullable: true,
            description: 'Характер груза',
            example: 'Два куба коробок',
          },
          weight: {
            type: 'string',
            nullable: true,
            description: 'Вес груза',
            example: '1200 кг',
          },
          volume: {
            type: 'string',
            nullable: true,
            description: 'Объём груза',
            example: '8 м3',
          },
          route: {
            type: 'string',
            nullable: true,
            description: 'Маршрут перевозки',
            example: 'Темрюк — Омск',
          },
          paymentMethod: {
            type: 'string',
            nullable: true,
            description: 'Форма оплаты',
            example: 'Безнал с НДС',
          },
          details: {
            type: 'string',
            nullable: true,
            description: 'Дополнительные параметры для расчёта (габариты, даты и т.д.)',
            example: 'Погрузка 22.04, разгрузка с пандуса',
          },
          botStopped: {
            type: 'boolean',
            description:
              'Если true — уже отправляли сообщение оператором через REST API для этой строки расчёта (без телефона); бот в этом чате входящих не обрабатывает.',
            example: false,
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
            description: 'Дата и время создания/обновления записи',
            example: '2026-04-10 12:34:56',
          },
        },
        required: ['id', 'chatId', 'createdAt'],
      },
      ChatEstimateList: {
        type: 'object',
        properties: {
          total: { type: 'integer', description: 'Количество записей в ответе', example: 3 },
          items: {
            type: 'array',
            items: { $ref: '#/components/schemas/ChatEstimate' },
          },
        },
        required: ['total', 'items'],
      },
      DeliverQuoteRequest: {
        type: 'object',
        properties: {
          price: {
            description: 'Стоимость для клиента (как показать в чате: текст или число)',
            oneOf: [{ type: 'string', example: '45 000 ₽' }, { type: 'number', example: 45000 }],
          },
        },
        required: ['price'],
      },
      DeliverQuoteResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: true },
          chat_id: { type: 'string', description: 'ID чата Авито', example: 'u2i-abc123' },
        },
        required: ['ok'],
      },
      SendMessageToClientBody: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description:
              'Текст сообщения в чат (от нашего аккаунта Авито). Для «расчёт без телефона» — POST `/chat-estimates/{id}/send-message`; для завершённой заявки с телефоном — POST `/clients/{id}/send-message`.',
            example: 'Уточните, пожалуйста, время погрузки.',
          },
        },
        required: ['text'],
      },
      SendMessageToClientResponse: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: true },
          chat_id: { type: 'string', description: 'ID чата Авито' },
          botStopped: {
            type: 'boolean',
            description:
              'После отправки включён режим только человека: бот входящих в этом чате не обрабатывает.',
            example: true,
          },
        },
        required: ['ok', 'chat_id', 'botStopped'],
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'Не авторизован' },
        },
        required: ['error'],
      },
      RuntimeMode: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['test', 'prod'], example: 'test' },
        },
        required: ['mode'],
      },
      DialogMessage: {
        type: 'object',
        description: 'Одно сообщение диалога (только текст и направление)',
        properties: {
          created: { type: 'integer', description: 'Unix timestamp от Авито' },
          direction: {
            type: 'string',
            enum: ['in', 'out'],
            description:
              '`in` — от клиента, `out` — от вашего аккаунта. Берётся из ответа Авито или по author_id.',
          },
          text: { type: 'string', description: 'Текст сообщения' },
        },
        required: ['created', 'direction', 'text'],
      },
      ClientDialog: {
        type: 'object',
        description: 'Диалог из чата Авито по заявке clients (хронологический порядок)',
        properties: {
          clientId: { type: 'integer' },
          chatId: { type: 'string' },
          messages: {
            type: 'array',
            items: { $ref: '#/components/schemas/DialogMessage' },
          },
        },
        required: ['clientId', 'chatId', 'messages'],
      },
      ChatEstimateDialog: {
        type: 'object',
        description:
          'Диалог из чата Авито по записи расчёта без телефона chat-estimates (тот же формат реплик, что у ClientDialog)',
        properties: {
          estimateId: { type: 'integer' },
          chatId: { type: 'string' },
          messages: {
            type: 'array',
            items: { $ref: '#/components/schemas/DialogMessage' },
          },
        },
        required: ['estimateId', 'chatId', 'messages'],
      },
    },
  },
  security: [{ BearerAuth: [] }],
  paths: {
    '/clients': {
      get: {
        summary: 'Список всех заявок',
        description:
          'Возвращает все подтверждённые заявки. Можно фильтровать по дате через параметр `since`.',
        operationId: 'getClients',
        tags: ['Заявки'],
        parameters: [
          {
            name: 'since',
            in: 'query',
            required: false,
            description:
              'Вернуть только заявки созданные с этой даты/времени (включительно). Формат: `YYYY-MM-DD` или `YYYY-MM-DD HH:MM:SS`',
            schema: { type: 'string', example: '2026-04-10' },
          },
        ],
        responses: {
          '200': {
            description: 'Успешно',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ClientList' },
              },
            },
          },
          '401': {
            description: 'Не авторизован',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
    '/clients/{id}': {
      get: {
        summary: 'Получить заявку по ID',
        operationId: 'getClientById',
        tags: ['Заявки'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Внутренний ID заявки',
            schema: { type: 'integer', example: 1 },
          },
        ],
        responses: {
          '200': {
            description: 'Заявка найдена',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Client' },
              },
            },
          },
          '401': {
            description: 'Не авторизован',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '404': {
            description: 'Не найдено',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
      delete: {
        summary: 'Удалить заявку по ID',
        description: 'Удаляет заявку из базы данных бота. Используется после успешного импорта в 1С.',
        operationId: 'deleteClient',
        tags: ['Заявки'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Внутренний ID заявки',
            schema: { type: 'integer', example: 1 },
          },
        ],
        responses: {
          '200': {
            description: 'Удалено',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { ok: { type: 'boolean', example: true } },
                },
              },
            },
          },
          '401': {
            description: 'Не авторизован',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '404': {
            description: 'Не найдено',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
    '/clients/{id}/messages': {
      get: {
        summary: 'Диалог из Авито (только реплики)',
        description:
          'По внутреннему ID из таблицы clients загружает историю чата. Для строк расчёта без телефона используйте GET /chat-estimates/{id}/messages.',
        operationId: 'getClientConversation',
        tags: ['Заявки'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Внутренний ID заявки (как в GET /clients/{id})',
            schema: { type: 'integer', example: 1 },
          },
        ],
        responses: {
          '200': {
            description: 'Успешно',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ClientDialog' },
              },
            },
          },
          '401': {
            description: 'Не авторизован',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '404': {
            description: 'Заявка не найдена',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '502': {
            description: 'Ошибка API Авито при загрузке сообщений',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
    '/clients/{id}/send-message': {
      post: {
        summary: 'Сообщение клиенту (заявка с телефоном)',
        description:
          'По записи таблицы clients (клиент уже оставил телефон мимо расчёта без номера): отправляет текст в чат Авито и включает ручной режим — входящих бот больше не обрабатывает. Для чатов на этапе «расчёт без телефона» используйте POST /chat-estimates/{id}/send-message.',
        operationId: 'sendMessageToClient',
        tags: ['Заявки'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Внутренний ID заявки',
            schema: { type: 'integer', example: 1 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SendMessageToClientBody' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Сообщение отправлено, бот заблокирован для этого клиента',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SendMessageToClientResponse' },
              },
            },
          },
          '400': {
            description: 'Нет текста или пустая строка',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '401': {
            description: 'Не авторизован',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '404': {
            description: 'Заявка не найдена',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '502': {
            description: 'Ошибка API Авито при отправке',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
    '/chat-estimates': {
      get: {
        summary: 'Запросы расчёта без телефона',
        description:
          'Заявки с полными параметрами груза, когда клиент не дал телефон. Фильтр `since` — как у /clients.',
        operationId: 'getChatEstimates',
        tags: ['Расчёт без телефона'],
        parameters: [
          {
            name: 'since',
            in: 'query',
            required: false,
            description:
              'Вернуть только записи с этой даты/времени (включительно). Формат: `YYYY-MM-DD` или `YYYY-MM-DD HH:MM:SS`',
            schema: { type: 'string', example: '2026-04-10' },
          },
        ],
        responses: {
          '200': {
            description: 'Успешно',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatEstimateList' },
              },
            },
          },
          '401': {
            description: 'Не авторизован',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
    '/chat-estimates/{id}': {
      get: {
        summary: 'Получить запрос расчёта по ID',
        operationId: 'getChatEstimateById',
        tags: ['Расчёт без телефона'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Внутренний ID записи',
            schema: { type: 'integer', example: 1 },
          },
        ],
        responses: {
          '200': {
            description: 'Найдено',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatEstimate' },
              },
            },
          },
          '401': {
            description: 'Не авторизован',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '404': {
            description: 'Не найдено',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
      delete: {
        summary: 'Удалить запрос расчёта по ID',
        description: 'Удаляет запись после успешного импорта во внешнюю систему.',
        operationId: 'deleteChatEstimate',
        tags: ['Расчёт без телефона'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Внутренний ID записи',
            schema: { type: 'integer', example: 1 },
          },
        ],
        responses: {
          '200': {
            description: 'Удалено',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { ok: { type: 'boolean', example: true } },
                },
              },
            },
          },
          '401': {
            description: 'Не авторизован',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '404': {
            description: 'Не найдено',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
    '/chat-estimates/{id}/messages': {
      get: {
        summary: 'Диалог из Авито для расчёта без телефона',
        description:
          'По внутреннему ID из GET /chat-estimates выгружает полную историю чата из Авито и возвращает упрощённые реплики (как GET /clients/{id}/messages).',
        operationId: 'getChatEstimateConversation',
        tags: ['Расчёт без телефона'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Внутренний ID записи (как в GET /chat-estimates/{id})',
            schema: { type: 'integer', example: 1 },
          },
        ],
        responses: {
          '200': {
            description: 'Успешно',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ChatEstimateDialog' },
              },
            },
          },
          '401': {
            description: 'Не авторизован',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '404': {
            description: 'Запись не найдена',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '502': {
            description: 'Ошибка API Авито при загрузке сообщений',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
    '/chat-estimates/{id}/deliver-quote': {
      post: {
        summary: 'Отправить цену в чат и запросить телефон',
        description:
          'По ID записи из chat-estimates отправляет в чат Авито текст с ценой и просьбой указать телефон, затем переводит диалог в режим дозаполнения телефона. В таблицу clients запись создаётся только после того, как клиент передаст номер.',
        operationId: 'deliverChatEstimateQuote',
        tags: ['Расчёт без телефона'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Внутренний ID записи chat_estimate_requests',
            schema: { type: 'integer', example: 1 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/DeliverQuoteRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Сообщение отправлено, ожидание номера от клиента',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DeliverQuoteResponse' },
              },
            },
          },
          '400': {
            description: 'Нет или пустое поле price',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '401': {
            description: 'Не авторизован',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '404': {
            description: 'Запись расчёта не найдена',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '409': {
            description: 'У чата уже есть телефон в clients',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '502': {
            description: 'Ошибка API Авито при отправке сообщения',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
    '/chat-estimates/{id}/send-message': {
      post: {
        summary: 'Отправить сообщение в чат расчёта без телефона и отключить автоответ бота',
        description:
          'По ID записи chat-estimates (клиент без телефона, этап расчёта) отправляет текст в Авито. После успешной отправки запись помечается: бот дальнейшие входящие в этом чате не обрабатывает.',
        operationId: 'sendMessageOnChatEstimate',
        tags: ['Расчёт без телефона'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Внутренний ID записи chat_estimate_requests',
            schema: { type: 'integer', example: 1 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SendMessageToClientBody' },
            },
          },
        },
        responses: {
          '200': {
            description: 'Сообщение отправлено, бот для этого диалога остановлен',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SendMessageToClientResponse' },
              },
            },
          },
          '400': {
            description: 'Нет текста или пустая строка',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '401': {
            description: 'Не авторизован',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '404': {
            description: 'Запись расчёта не найдена',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
          '502': {
            description: 'Ошибка API Авито при отправке',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
    '/runtime-mode': {
      get: {
        summary: 'Текущий runtime-режим бота',
        operationId: 'getRuntimeMode',
        tags: ['Управление'],
        responses: {
          '200': {
            description: 'Успешно',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RuntimeMode' } },
            },
          },
        },
      },
      put: {
        summary: 'Переключить runtime-режим бота',
        operationId: 'setRuntimeMode',
        tags: ['Управление'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  mode: { type: 'string', enum: ['test', 'prod'], example: 'prod' },
                },
                required: ['mode'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Режим обновлен',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/RuntimeMode' } },
            },
          },
          '400': {
            description: 'Некорректный режим',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
  },
};

// ─── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const apiToken = config.api.token;

  if (!apiToken) {
    next();
    return;
  }

  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (token !== apiToken) {
    res.status(401).json({ error: 'Не авторизован' });
    return;
  }

  next();
}

// ─── Server ───────────────────────────────────────────────────────────────────

/** Express-приложение без listen — для тестов (supertest) и продакшена. */
export function createApiApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  attachAdminPanel(app);

  // ── Swagger UI (без авторизации — доступен для просмотра документации) ──
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerDocument, {
      swaggerOptions: {
        persistAuthorization: true,
      },
      customSiteTitle: 'Avito Bot API',
    }),
  );

  // ── Swagger JSON (для импорта в 1С или Postman) ──
  app.get('/api/openapi.json', (_req, res) => {
    res.json(swaggerDocument);
  });

  // ── REST endpoints ───────────────────────────────────────────────────────

  // GET /api/v1/clients[?since=2026-04-01]
  app.get('/api/v1/clients', requireAuth, (req: Request, res: Response) => {
    const since = req.query.since as string | undefined;
    const items = since ? getClientsSince(since) : getClients();
    res.json({ total: items.length, items });
  });

  // GET /api/v1/clients/:id/messages — история из мессенджера Авито
  app.get('/api/v1/clients/:id/messages', requireAuth, async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Некорректный ID' });
      return;
    }
    const client = getClientById(id);
    if (!client) {
      if (getChatEstimateById(id)) {
        res.status(404).json({
          error:
            'Это запись расчёта без телефона. Используйте GET /api/v1/chat-estimates/:id/messages',
        });
        return;
      }
      res.status(404).json({ error: 'Заявка не найдена' });
      return;
    }
    try {
      const rawMessages = await getChatMessagesAll(client.chatId);
      const messages = await dialogFromAvitoMessages(rawMessages);
      res.json({
        clientId: client.id,
        chatId: client.chatId,
        messages,
      });
    } catch (err) {
      logger.error({ err, chatId: client.chatId }, 'clients/:id/messages: Avito API failed');
      res.status(502).json({ error: 'Не удалось получить сообщения из Авито' });
    }
  });

  // POST /api/v1/clients/:id/send-message  { "text": "..." }
  app.post('/api/v1/clients/:id/send-message', requireAuth, async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Некорректный ID' });
      return;
    }
    const textRaw = req.body?.text;
    const text = typeof textRaw === 'string' ? textRaw.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'Укажите непустое поле text' });
      return;
    }

    const client = getClientById(id);
    if (!client) {
      if (getChatEstimateById(id)) {
        res.status(404).json({
          error: 'Это запись расчёта без телефона (таблица chat-estimates). Используйте POST /api/v1/chat-estimates/:id/send-message',
        });
        return;
      }
      res.status(404).json({ error: 'Заявка не найдена' });
      return;
    }

    try {
      await sendMessage(client.chatId, text);
      setClientTakenOverViaApi(client.id);
      res.json({ ok: true, chat_id: client.chatId, botStopped: true });
    } catch (err) {
      logger.error({ err, chatId: client.chatId, clientId: id }, 'clients/:id/send-message: Avito API failed');
      res.status(502).json({ error: 'Не удалось отправить сообщение в Авито' });
    }
  });

  // GET /api/v1/clients/:id
  app.get('/api/v1/clients/:id', requireAuth, (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Некорректный ID' });
      return;
    }
    const client = getClientById(id);
    if (!client) {
      res.status(404).json({ error: 'Заявка не найдена' });
      return;
    }
    res.json(client);
  });

  // DELETE /api/v1/clients/:id
  app.delete('/api/v1/clients/:id', requireAuth, (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Некорректный ID' });
      return;
    }
    const deleted = deleteClient(id);
    if (!deleted) {
      res.status(404).json({ error: 'Заявка не найдена' });
      return;
    }
    res.json({ ok: true });
  });

  // GET /api/v1/chat-estimates[?since=...]
  app.get('/api/v1/chat-estimates', requireAuth, (req: Request, res: Response) => {
    const since = req.query.since as string | undefined;
    const items = since ? getChatEstimatesSince(since) : getChatEstimates();
    res.json({ total: items.length, items });
  });

  // GET /api/v1/chat-estimates/:id/messages — история для расчёта без телефона
  app.get('/api/v1/chat-estimates/:id/messages', requireAuth, async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Некорректный ID' });
      return;
    }
    const estimate = getChatEstimateById(id);
    if (!estimate) {
      if (getClientById(id)) {
        res.status(404).json({
          error: 'Это заявка из clients. Используйте GET /api/v1/clients/:id/messages',
        });
        return;
      }
      res.status(404).json({ error: 'Запись не найдена' });
      return;
    }
    try {
      const rawMessages = await getChatMessagesAll(estimate.chatId);
      const messages = await dialogFromAvitoMessages(rawMessages);
      res.json({
        estimateId: estimate.id,
        chatId: estimate.chatId,
        messages,
      });
    } catch (err) {
      logger.error({ err, chatId: estimate.chatId }, 'chat-estimates/:id/messages: Avito API failed');
      res.status(502).json({ error: 'Не удалось получить сообщения из Авито' });
    }
  });

  // GET /api/v1/chat-estimates/:id
  app.get('/api/v1/chat-estimates/:id', requireAuth, (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Некорректный ID' });
      return;
    }
    const row = getChatEstimateById(id);
    if (!row) {
      res.status(404).json({ error: 'Запись не найдена' });
      return;
    }
    res.json(row);
  });

  // DELETE /api/v1/chat-estimates/:id
  app.delete('/api/v1/chat-estimates/:id', requireAuth, (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Некорректный ID' });
      return;
    }
    const deleted = deleteChatEstimateRequest(id);
    if (!deleted) {
      res.status(404).json({ error: 'Запись не найдена' });
      return;
    }
    res.json({ ok: true });
  });

  // POST /api/v1/chat-estimates/:id/send-message  { "text": "..." }
  app.post(
    '/api/v1/chat-estimates/:id/send-message',
    requireAuth,
    async (req: Request, res: Response) => {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Некорректный ID' });
        return;
      }
      const textRaw = req.body?.text;
      const text = typeof textRaw === 'string' ? textRaw.trim() : '';
      if (!text) {
        res.status(400).json({ error: 'Укажите непустое поле text' });
        return;
      }

      const estimate = getChatEstimateById(id);
      if (!estimate) {
        if (getClientById(id)) {
          res.status(404).json({
            error:
              'Это заявка с телефоном из таблицы clients. Используйте POST /api/v1/clients/:id/send-message',
          });
          return;
        }
        res.status(404).json({ error: 'Запись не найдена' });
        return;
      }

      try {
        await sendMessage(estimate.chatId, text);
        setChatEstimateTakenOverViaApi(estimate.id);
        res.json({ ok: true, chat_id: estimate.chatId, botStopped: true });
      } catch (err) {
        logger.error({ err, chatId: estimate.chatId, estimateId: id }, 'chat-estimates/:id/send-message failed');
        res.status(502).json({ error: 'Не удалось отправить сообщение в Авито' });
      }
    },
  );

  // POST /api/v1/chat-estimates/:id/deliver-quote  { "price": "45 000 ₽" }
  app.post(
    '/api/v1/chat-estimates/:id/deliver-quote',
    requireAuth,
    async (req: Request, res: Response) => {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Некорректный ID' });
        return;
      }
      const result = await deliverQuoteFromChatEstimateId(id, req.body);
      res.status(result.status).json(result.body);
    },
  );

  app.get('/api/v1/runtime-mode', requireAuth, (_req: Request, res: Response) => {
    res.json({ mode: getRuntimeMode() });
  });

  app.put('/api/v1/runtime-mode', requireAuth, (req: Request, res: Response) => {
    const modeRaw = String(req.body?.mode ?? '').trim();
    if (modeRaw !== 'test' && modeRaw !== 'prod') {
      res.status(400).json({ error: 'mode должен быть test или prod' });
      return;
    }
    const mode = setRuntimeMode(modeRaw);
    res.json({ mode });
  });

  // Health
  app.get('/health', (_req, res) => res.json({ ok: true }));

  return app;
}

export function startApiServer(): void {
  const app = createApiApp();
  const port = config.api.port;
  app.listen(port, () => {
    logger.info('API server listening on port %d  →  http://localhost:%d/docs', port, port);
    if (config.admin.enabled) {
      logger.info('Admin panel  →  http://localhost:%d/admin', port);
    }
  });
}
