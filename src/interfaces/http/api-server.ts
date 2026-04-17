import express, { Request, Response, NextFunction } from 'express';
import swaggerUi from 'swagger-ui-express';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import {
  getClients,
  getClientById,
  getClientsSince,
  deleteClient,
} from '../../infrastructure/storage/repository.js';

// ─── OpenAPI spec ─────────────────────────────────────────────────────────────

const swaggerDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Avito Bot — API для 1С',
    version: '1.0.0',
    description:
      'REST API для выгрузки заявок клиентов, собранных ботом Авито, в 1С или любую внешнюю систему.',
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
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'Не авторизован' },
        },
        required: ['error'],
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

export function startApiServer(): void {
  const app = express();
  app.use(express.json());

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

  // Health
  app.get('/health', (_req, res) => res.json({ ok: true }));

  const port = config.api.port;
  app.listen(port, () => {
    logger.info('API server listening on port %d  →  http://localhost:%d/docs', port, port);
  });
}
