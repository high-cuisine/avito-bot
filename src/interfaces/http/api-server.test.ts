import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDatabaseForTests,
  saveClient,
  upsertChatEstimateRequest,
} from '../../infrastructure/storage/repository.js';

const sendMessage = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock('../../integrations/avito/client.js', () => ({
  sendMessage,
}));

const API_TOKEN = 'vitest-api-secret-token';

describe('createApiApp', () => {
  beforeEach(() => {
    clearDatabaseForTests();
    sendMessage.mockClear();
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

  it('GET /api/v1/chat-estimates', async () => {
    const { createApiApp } = await import('./api-server.js');
    const res = await request(createApiApp())
      .get('/api/v1/chat-estimates')
      .set('Authorization', `Bearer ${API_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('POST /api/v1/chat-estimates/:id/deliver-quote', async () => {
    upsertChatEstimateRequest({
      chatId: 'api-ch',
      itemId: '1',
      clientName: 'Тест',
      cargo: 'груз',
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
});
