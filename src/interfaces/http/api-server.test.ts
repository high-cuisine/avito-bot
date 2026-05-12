import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDatabaseForTests,
  saveClient,
  upsertChatEstimateRequest,
} from '../../infrastructure/storage/repository.js';

const sendMessage = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const resolveUserId = vi.hoisted(() => vi.fn().mockResolvedValue('222'));
const getChatMessagesAll = vi.hoisted(() => vi.fn().mockResolvedValue([]));

vi.mock('../../integrations/avito/client.js', () => ({
  sendMessage,
  resolveUserId,
  getChatMessagesAll,
}));

const API_TOKEN = 'vitest-api-secret-token';

describe('createApiApp', () => {
  beforeEach(() => {
    clearDatabaseForTests();
    sendMessage.mockClear();
    resolveUserId.mockClear();
    getChatMessagesAll.mockClear();
    resolveUserId.mockResolvedValue('222');
    getChatMessagesAll.mockResolvedValue([]);
  });

  it('GET /health', async () => {
    const { createApiApp } = await import('./api-server.js');
    const res = await request(createApiApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('GET /api/v1/clients without bearer → 401', async () => {
    const { createApiApp } = await import('./api-server.js');
    const res = await request(createApiApp()).get('/api/v1/clients');
    expect(res.status).toBe(401);
  });

  it('GET /api/v1/clients with bearer', async () => {
    const { createApiApp } = await import('./api-server.js');
    const res = await request(createApiApp())
      .get('/api/v1/clients')
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total: 0, items: [] });
  });

  it('GET /api/v1/clients/:id 404', async () => {
    const { createApiApp } = await import('./api-server.js');
    const res = await request(createApiApp())
      .get('/api/v1/clients/999')
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('GET /api/v1/clients/:id/messages returns Avito transcript', async () => {
    saveClient({
      chatId: 'avito-chat-xyz',
      itemId: 'i9',
      clientName: 'Пётр',
      cargo: 'Тест',
      route: 'А — Б',
      paymentMethod: 'нал',
      phone: '+79001112233',
    });
    const { getClientByChatId } = await import('../../infrastructure/storage/repository.js');
    const id = getClientByChatId('avito-chat-xyz')!.id;

    getChatMessagesAll.mockResolvedValueOnce([
      {
        id: 'm1',
        author_id: 111,
        chat_id: 'avito-chat-xyz',
        created: 1700001000,
        type: 'text',
        content: { text: 'Здравствуйте' },
      },
      {
        id: 'm2',
        author_id: 222,
        chat_id: 'avito-chat-xyz',
        created: 1700002000,
        type: 'text',
        content: { text: 'Здравствуйте!' },
      },
    ]);

    const { createApiApp } = await import('./api-server.js');
    const res = await request(createApiApp())
      .get(`/api/v1/clients/${id}/messages`)
      .set('Authorization', `Bearer ${API_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.clientId).toBe(id);
    expect(res.body.chatId).toBe('avito-chat-xyz');
    expect(res.body.messages).toEqual([
      { created: 1700001000, direction: 'in', text: 'Здравствуйте' },
      { created: 1700002000, direction: 'out', text: 'Здравствуйте!' },
    ]);
    expect(getChatMessagesAll).toHaveBeenCalledWith('avito-chat-xyz');
    expect(resolveUserId).toHaveBeenCalled();
  });

  it('GET /api/v1/clients/:id/messages 502 when Avito fails', async () => {
    saveClient({
      chatId: 'bad-chat',
      itemId: '',
      clientName: '',
      cargo: 'x',
      route: 'y',
      paymentMethod: 'z',
      phone: '+79000000001',
    });
    const { getClientByChatId } = await import('../../infrastructure/storage/repository.js');
    const id = getClientByChatId('bad-chat')!.id;
    getChatMessagesAll.mockRejectedValueOnce(new Error('Avito API 500'));

    const { createApiApp } = await import('./api-server.js');
    const res = await request(createApiApp())
      .get(`/api/v1/clients/${id}/messages`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(res.status).toBe(502);
  });

  it('POST /api/v1/clients/:id/send-message sends text and sets botStopped', async () => {
    saveClient({
      chatId: 'api-send-chat',
      itemId: '1',
      clientName: 'Вася',
      cargo: 'x',
      route: 'a',
      paymentMethod: 'б',
      phone: '+79111111111',
    });
    const { getClientByChatId, getClientById } = await import('../../infrastructure/storage/repository.js');
    const id = getClientByChatId('api-send-chat')!.id;
    expect(getClientById(id)?.botStopped).toBe(false);

    const { createApiApp } = await import('./api-server.js');
    const res = await request(createApiApp())
      .post(`/api/v1/clients/${id}/send-message`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ text: 'Пишите менеджеру' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      chat_id: 'api-send-chat',
      botStopped: true,
    });
    expect(sendMessage).toHaveBeenCalledWith('api-send-chat', 'Пишите менеджеру');
    expect(getClientById(id)?.botStopped).toBe(true);
  });

  it('POST /api/v1/clients/:id/send-message 400 for empty text', async () => {
    saveClient({
      chatId: 'empty-send',
      itemId: '',
      clientName: '',
      cargo: 'x',
      route: 'a',
      paymentMethod: 'b',
      phone: '+79000000002',
    });
    const { getClientByChatId } = await import('../../infrastructure/storage/repository.js');
    const id = getClientByChatId('empty-send')!.id;
    const { createApiApp } = await import('./api-server.js');
    const res = await request(createApiApp())
      .post(`/api/v1/clients/${id}/send-message`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ text: '   ' });
    expect(res.status).toBe(400);
  });

  it('POST send-message 502 and does not set botStopped when Avito fails', async () => {
    saveClient({
      chatId: 'fail-send-chat',
      itemId: '',
      clientName: '',
      cargo: 'x',
      route: 'a',
      paymentMethod: 'b',
      phone: '+79000000003',
    });
    const { getClientByChatId, getClientById } = await import('../../infrastructure/storage/repository.js');
    const id = getClientByChatId('fail-send-chat')!.id;
    sendMessage.mockRejectedValueOnce(new Error('Avito unavailable'));

    const { createApiApp } = await import('./api-server.js');
    const res = await request(createApiApp())
      .post(`/api/v1/clients/${id}/send-message`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ text: 'Привет' });
    expect(res.status).toBe(502);
    expect(getClientById(id)?.botStopped).toBe(false);
  });

  it('GET /api/v1/clients/:id returns cargoDetails', async () => {
    saveClient({
      chatId: 'api-client-cargo',
      itemId: 'i1',
      clientName: 'Иван',
      cargo: 'Мебель',
      cargoDetails: '2 шкафа, 600 кг',
      route: 'Тверь — Москва',
      paymentMethod: 'безнал',
      phone: '+79001234567',
    });
    const { getClientByChatId } = await import('../../infrastructure/storage/repository.js');
    const id = getClientByChatId('api-client-cargo')!.id;

    const { createApiApp } = await import('./api-server.js');
    const res = await request(createApiApp())
      .get(`/api/v1/clients/${id}`)
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.cargoDetails).toBe('2 шкафа, 600 кг');
  });

  it('GET /api/v1/chat-estimates', async () => {
    upsertChatEstimateRequest({
      chatId: 'ce-1',
      itemId: '1',
      clientName: 'Клиент',
      cargo: 'Оборудование',
      weight: '800 кг',
      volume: '6 м3',
      route: 'Казань — Пермь',
      paymentMethod: 'безнал',
      details: null,
    });
    const { createApiApp } = await import('./api-server.js');
    const res = await request(createApiApp())
      .get('/api/v1/chat-estimates')
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.items[0].weight).toBe('800 кг');
    expect(res.body.items[0].volume).toBe('6 м3');
  });

  it('POST /api/v1/chat-estimates/:id/deliver-quote', async () => {
    upsertChatEstimateRequest({
      chatId: 'api-ch',
      itemId: '1',
      clientName: 'Тест',
      cargo: 'груз',
      weight: '1200 кг',
      volume: '9 м3',
      route: 'А — Б',
      paymentMethod: 'нал',
      details: null,
    });
    const { getChatEstimates } = await import('../../infrastructure/storage/repository.js');
    const id = getChatEstimates()[0]!.id;

    const { createApiApp } = await import('./api-server.js');
    const res = await request(createApiApp())
      .post(`/api/v1/chat-estimates/${id}/deliver-quote`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ price: '40 000 ₽' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, chat_id: 'api-ch' });
    expect(sendMessage).toHaveBeenCalledWith('api-ch', expect.stringContaining('40 000 ₽'));
  });

  it('POST deliver-quote 400 without price', async () => {
    upsertChatEstimateRequest({
      chatId: 'api-ch2',
      itemId: '',
      clientName: '',
      cargo: 'a',
      weight: '1 кг',
      volume: '1 м3',
      route: 'b',
      paymentMethod: 'c',
      details: null,
    });
    const { getChatEstimates } = await import('../../infrastructure/storage/repository.js');
    const id = getChatEstimates().find((e) => e.chatId === 'api-ch2')!.id;

    const { createApiApp } = await import('./api-server.js');
    const res = await request(createApiApp())
      .post(`/api/v1/chat-estimates/${id}/deliver-quote`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('POST deliver-quote 409 when phone already set', async () => {
    upsertChatEstimateRequest({
      chatId: 'api-ch3',
      itemId: '',
      clientName: '',
      cargo: 'a',
      weight: '1 кг',
      volume: '1 м3',
      route: 'b',
      paymentMethod: 'c',
      details: null,
    });
    saveClient({
      chatId: 'api-ch3',
      itemId: '',
      clientName: '',
      cargo: 'a',
      route: 'b',
      paymentMethod: 'c',
      phone: '+79000000099',
    });
    const { getChatEstimates } = await import('../../infrastructure/storage/repository.js');
    const id = getChatEstimates().find((e) => e.chatId === 'api-ch3')!.id;

    const { createApiApp } = await import('./api-server.js');
    const res = await request(createApiApp())
      .post(`/api/v1/chat-estimates/${id}/deliver-quote`)
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ price: '1' });

    expect(res.status).toBe(409);
  });

  it('runtime mode endpoints work', async () => {
    const { createApiApp } = await import('./api-server.js');
    const app = createApiApp();

    const initial = await request(app)
      .get('/api/v1/runtime-mode')
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(initial.status).toBe(200);
    expect(initial.body.mode).toBe('test');

    const updated = await request(app)
      .put('/api/v1/runtime-mode')
      .set('Authorization', `Bearer ${API_TOKEN}`)
      .send({ mode: 'prod' });
    expect(updated.status).toBe(200);
    expect(updated.body.mode).toBe('prod');
  });

  it('admin panel login and runtime switch', async () => {
    const { createApiApp } = await import('./api-server.js');
    const app = createApiApp();

    const gate = await request(app).get('/admin');
    expect(gate.status).toBe(200);
    expect(gate.text).toContain('Админка');

    const bad = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ login: 'testadmin', password: 'wrong' });
    expect(bad.status).toBe(401);

    const login = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ login: 'testadmin', password: 'test-admin-pass' });
    expect(login.status).toBe(302);
    expect(login.headers.location).toBe('/admin');
    const cookieHeader = login.headers['set-cookie'];
    expect(cookieHeader).toBeDefined();

    const dash = await request(app).get('/admin').set('Cookie', cookieHeader!);
    expect(dash.status).toBe(200);
    expect(dash.text).toContain('TEST');

    const switchProd = await request(app)
      .post('/admin/runtime')
      .type('form')
      .set('Cookie', cookieHeader!)
      .send({ mode: 'prod' });
    expect(switchProd.status).toBe(200);
    expect(switchProd.text).toContain('PROD');
  });
});
