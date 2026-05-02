import { beforeEach, describe, expect, it } from 'vitest';
import {
  addTelegramAllowedUser,
  clearDatabaseForTests,
  deleteChatEstimateRequest,
  deleteClient,
  deleteSession,
  getChatEstimateById,
  getChatEstimates,
  getChatEstimatesSince,
  getClientByChatId,
  getClientById,
  getClientsSince,
  getRuntimeMode,
  getTelegramAllowedUsers,
  isTelegramUserAllowed,
  removeTelegramAllowedUser,
  saveClient,
  saveSession,
  setRuntimeMode,
  upsertChatEstimateRequest,
} from './repository.js';

describe('repository', () => {
  beforeEach(() => {
    clearDatabaseForTests();
  });

  it('saveClient and getClientByChatId / getClientById', () => {
    saveClient({
      chatId: 'ch-1',
      itemId: 'item1',
      clientName: 'Иван',
      cargo: 'коробки',
      cargoDetails: '2 паллеты, до 1.5 т',
      route: 'Москва — Тверь',
      paymentMethod: 'нал',
      phone: '+79001234567',
    });
    const byChat = getClientByChatId('ch-1');
    expect(byChat?.phone).toBe('+79001234567');
    expect(byChat?.cargoDetails).toBe('2 паллеты, до 1.5 т');
    const byId = getClientById(byChat!.id);
    expect(byId?.chatId).toBe('ch-1');
  });

  it('upsertChatEstimateRequest and get by id / since', () => {
    upsertChatEstimateRequest({
      chatId: 'ch-est',
      itemId: 'i1',
      clientName: 'Пётр',
      cargo: 'паллеты',
      weight: '2000 кг',
      volume: '14 м3',
      route: 'А — Б',
      paymentMethod: 'безнал',
      details: 'до 5 т',
    });
    const list = getChatEstimates();
    expect(list.length).toBe(1);
    const row = getChatEstimateById(list[0]!.id)!;
    expect(row.chatId).toBe('ch-est');
    expect(row.details).toBe('до 5 т');
    const since = getChatEstimatesSince('2000-01-01');
    expect(since.length).toBe(1);
  });

  it('deleteChatEstimateRequest and deleteClient', () => {
    upsertChatEstimateRequest({
      chatId: 'x',
      itemId: '',
      clientName: '',
      cargo: 'a',
      weight: '1 кг',
      volume: '1 м3',
      route: 'b',
      paymentMethod: 'c',
      details: null,
    });
    const id = getChatEstimates()[0]!.id;
    expect(deleteChatEstimateRequest(id)).toBe(true);
    expect(getChatEstimateById(id)).toBeNull();

    saveClient({
      chatId: 'del-me',
      itemId: '',
      clientName: '',
      cargo: 'a',
      route: 'b',
      paymentMethod: 'c',
      phone: '+79000000000',
    });
    const cid = getClientByChatId('del-me')!.id;
    expect(deleteClient(cid)).toBe(true);
  });

  it('saveSession and deleteSession', () => {
    saveSession('s1', 'LLM', {
      itemId: '',
      clientName: '',
      cargo: '',
      route: '',
      paymentMethod: '',
      phone: '',
      llmMessages: [],
    });
    deleteSession('s1');
  });

  it('getClientsSince filters by created_at', () => {
    saveClient({
      chatId: 'old',
      itemId: '',
      clientName: '',
      cargo: 'a',
      route: 'b',
      paymentMethod: 'c',
      phone: '+79000000001',
    });
    const rows = getClientsSince('2099-01-01');
    expect(rows.length).toBe(0);
    const rows2 = getClientsSince('2000-01-01');
    expect(rows2.length).toBeGreaterThanOrEqual(1);
  });

  it('stores runtime mode in database', () => {
    expect(getRuntimeMode()).toBe('test');
    expect(setRuntimeMode('prod')).toBe('prod');
    expect(getRuntimeMode()).toBe('prod');
    expect(setRuntimeMode('test')).toBe('test');
  });

  it('manages telegram allowed users', () => {
    expect(getTelegramAllowedUsers()).toEqual([]);
    expect(isTelegramUserAllowed('123')).toBe(false);

    addTelegramAllowedUser('123');
    addTelegramAllowedUser('456');

    expect(getTelegramAllowedUsers()).toEqual(['123', '456']);
    expect(isTelegramUserAllowed('123')).toBe(true);
    expect(removeTelegramAllowedUser('123')).toBe(true);
    expect(isTelegramUserAllowed('123')).toBe(false);
    expect(removeTelegramAllowedUser('999')).toBe(false);
  });
});
