import { Database } from 'bun:sqlite';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), 'data.db');

const db = new Database(DB_PATH, { create: true });
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    chat_id    TEXT PRIMARY KEY,
    state      TEXT NOT NULL,
    data       TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clients (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id        TEXT UNIQUE NOT NULL,
    item_id        TEXT,
    client_name    TEXT,
    cargo          TEXT,
    route          TEXT,
    payment_method TEXT,
    phone          TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

try {
  db.exec('ALTER TABLE clients ADD COLUMN phone TEXT');
} catch {
  // column already exists
}
try {
  db.exec('ALTER TABLE clients ADD COLUMN cargo_details TEXT');
} catch {
  // column already exists
}

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_estimate_requests (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id        TEXT UNIQUE NOT NULL,
    item_id        TEXT,
    client_name    TEXT,
    cargo          TEXT,
    route          TEXT,
    payment_method TEXT,
    details        TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export type LlmToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

/** История для OpenAI: user/assistant текст и цепочки tool. */
export type LlmChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: LlmToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface SessionData {
  itemId: string;
  clientName: string;
  cargo: string;
  route: string;
  paymentMethod: string;
  phone: string;
  cargoDetails?: string;
  /** Телефон уже сохранён в clients до полного опроса (первый сценарий). */
  capturedPhone?: string;
  /** История диалога с моделью (без system) */
  llmMessages?: LlmChatMessage[];
  /**
   * phone_intent — сначала согласие на телефон;
   * survey — полная заявка с телефоном;
   * survey_estimate_only — только расчёт по параметрам без телефона;
   * phone_backfill — в БД уже есть заявка, не хватает телефона.
   * engaged — обычный свободный диалог, телефон уже есть;
   * post_quote — реакция после отправленной цены.
   */
  chatMode?:
    | 'phone_intent'
    | 'survey'
    | 'survey_estimate_only'
    | 'phone_backfill'
    | 'engaged'
    | 'post_quote';
  postQuotePhase?: 'awaiting_sentiment' | 'awaiting_phone' | 'phone_captured';
}

export interface Session {
  chatId: string;
  state: string;
  data: SessionData;
}

const stmtGetSession = db.prepare(
  'SELECT chat_id, state, data FROM sessions WHERE chat_id = ?',
);

const stmtUpsertSession = db.prepare(`
  INSERT INTO sessions (chat_id, state, data, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(chat_id) DO UPDATE SET state = excluded.state,
                                     data = excluded.data,
                                     updated_at = excluded.updated_at
`);

const stmtDeleteSession = db.prepare('DELETE FROM sessions WHERE chat_id = ?');

export function getSession(chatId: string): Session | null {
  const row = stmtGetSession.get(chatId) as
    | { chat_id: string; state: string; data: string }
    | undefined;
  if (!row) return null;
  return {
    chatId: row.chat_id,
    state: row.state,
    data: JSON.parse(row.data) as SessionData,
  };
}

export function saveSession(chatId: string, state: string, data: SessionData): void {
  stmtUpsertSession.run(chatId, state, JSON.stringify(data));
}

export function deleteSession(chatId: string): void {
  stmtDeleteSession.run(chatId);
}

export interface ClientRecord {
  id: number;
  chatId: string;
  itemId: string | null;
  clientName: string | null;
  cargo: string | null;
  cargoDetails: string | null;
  route: string | null;
  paymentMethod: string | null;
  phone: string | null;
  createdAt: string;
}

const stmtInsertClient = db.prepare(`
  INSERT INTO clients (chat_id, item_id, client_name, cargo, cargo_details, route, payment_method, phone, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(chat_id) DO UPDATE SET item_id        = excluded.item_id,
                                     client_name    = excluded.client_name,
                                     cargo          = excluded.cargo,
                                     cargo_details  = excluded.cargo_details,
                                     route          = excluded.route,
                                     payment_method = excluded.payment_method,
                                     phone          = excluded.phone,
                                     created_at     = excluded.created_at
`);

const stmtGetClients = db.prepare(
  'SELECT id, chat_id, item_id, client_name, cargo, cargo_details, route, payment_method, phone, created_at FROM clients ORDER BY id DESC',
);
const stmtGetClientById = db.prepare(
  'SELECT id, chat_id, item_id, client_name, cargo, cargo_details, route, payment_method, phone, created_at FROM clients WHERE id = ?',
);
const stmtGetClientsSince = db.prepare(
  `SELECT id, chat_id, item_id, client_name, cargo, cargo_details, route, payment_method, phone, created_at
   FROM clients WHERE created_at >= ? ORDER BY id ASC`,
);
const stmtDeleteClient = db.prepare('DELETE FROM clients WHERE id = ?');
const stmtGetClientByChatId = db.prepare(
  'SELECT id, chat_id, item_id, client_name, cargo, cargo_details, route, payment_method, phone, created_at FROM clients WHERE chat_id = ?',
);
const stmtGetClientsMissingPhone = db.prepare(
  `SELECT id, chat_id, item_id, client_name, cargo, cargo_details, route, payment_method, phone, created_at
   FROM clients
   WHERE phone IS NULL OR trim(phone) = ''
   ORDER BY id ASC`,
);
const stmtUpdateClientPhoneByChatId = db.prepare(
  `UPDATE clients
   SET phone = ?
   WHERE chat_id = ?`,
);

export function saveClient(data: SessionData & { chatId: string }): void {
  stmtInsertClient.run(
    data.chatId,
    data.itemId || null,
    data.clientName || null,
    data.cargo || null,
    data.cargoDetails || null,
    data.route || null,
    data.paymentMethod || null,
    data.phone || null,
  );
}

type ClientRow = {
  id: number;
  chat_id: string;
  item_id: string | null;
  client_name: string | null;
  cargo: string | null;
  cargo_details: string | null;
  route: string | null;
  payment_method: string | null;
  phone: string | null;
  created_at: string;
};

function rowToRecord(r: ClientRow): ClientRecord {
  return {
    id: r.id,
    chatId: r.chat_id,
    itemId: r.item_id,
    clientName: r.client_name,
    cargo: r.cargo,
    cargoDetails: r.cargo_details,
    route: r.route,
    paymentMethod: r.payment_method,
    phone: r.phone,
    createdAt: r.created_at,
  };
}

export function getClients(): ClientRecord[] {
  return (stmtGetClients.all() as ClientRow[]).map(rowToRecord);
}

export function getClientById(id: number): ClientRecord | null {
  const row = stmtGetClientById.get(id) as ClientRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function getClientByChatId(chatId: string): ClientRecord | null {
  const row = stmtGetClientByChatId.get(chatId) as ClientRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function getClientsMissingPhone(limit = 100): ClientRecord[] {
  return (stmtGetClientsMissingPhone.all() as ClientRow[])
    .slice(0, Math.max(0, limit))
    .map(rowToRecord);
}

export function updateClientPhoneByChatId(chatId: string, phone: string): boolean {
  const result = stmtUpdateClientPhoneByChatId.run(phone, chatId);
  return result.changes > 0;
}

export function getClientsSince(since: string): ClientRecord[] {
  return (stmtGetClientsSince.all(since) as ClientRow[]).map(rowToRecord);
}

export function deleteClient(id: number): boolean {
  const result = stmtDeleteClient.run(id);
  return result.changes > 0;
}

// ─── Заявки «расчёт без телефона» (только чат / внешняя выгрузка) ─────────────

export interface ChatEstimateRecord {
  id: number;
  chatId: string;
  itemId: string | null;
  clientName: string | null;
  cargo: string | null;
  route: string | null;
  paymentMethod: string | null;
  details: string | null;
  createdAt: string;
}

export interface ChatEstimateUpsertInput {
  chatId: string;
  itemId: string;
  clientName: string;
  cargo: string;
  route: string;
  paymentMethod: string;
  details: string | null;
}

const stmtUpsertChatEstimate = db.prepare(`
  INSERT INTO chat_estimate_requests (chat_id, item_id, client_name, cargo, route, payment_method, details, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(chat_id) DO UPDATE SET item_id         = excluded.item_id,
                                      client_name    = excluded.client_name,
                                      cargo          = excluded.cargo,
                                      route          = excluded.route,
                                      payment_method = excluded.payment_method,
                                      details        = excluded.details,
                                      created_at     = excluded.created_at
`);

const stmtGetChatEstimates = db.prepare(
  `SELECT id, chat_id, item_id, client_name, cargo, route, payment_method, details, created_at
   FROM chat_estimate_requests ORDER BY id DESC`,
);
const stmtGetChatEstimateById = db.prepare(
  `SELECT id, chat_id, item_id, client_name, cargo, route, payment_method, details, created_at
   FROM chat_estimate_requests WHERE id = ?`,
);
const stmtGetChatEstimatesSince = db.prepare(
  `SELECT id, chat_id, item_id, client_name, cargo, route, payment_method, details, created_at
   FROM chat_estimate_requests WHERE created_at >= ? ORDER BY id ASC`,
);
const stmtDeleteChatEstimate = db.prepare('DELETE FROM chat_estimate_requests WHERE id = ?');

type ChatEstimateRow = {
  id: number;
  chat_id: string;
  item_id: string | null;
  client_name: string | null;
  cargo: string | null;
  route: string | null;
  payment_method: string | null;
  details: string | null;
  created_at: string;
};

function chatEstimateRowToRecord(r: ChatEstimateRow): ChatEstimateRecord {
  return {
    id: r.id,
    chatId: r.chat_id,
    itemId: r.item_id,
    clientName: r.client_name,
    cargo: r.cargo,
    route: r.route,
    paymentMethod: r.payment_method,
    details: r.details,
    createdAt: r.created_at,
  };
}

export function upsertChatEstimateRequest(data: ChatEstimateUpsertInput): void {
  stmtUpsertChatEstimate.run(
    data.chatId,
    data.itemId || null,
    data.clientName || null,
    data.cargo,
    data.route,
    data.paymentMethod,
    data.details,
  );
}

export function getChatEstimates(): ChatEstimateRecord[] {
  return (stmtGetChatEstimates.all() as ChatEstimateRow[]).map(chatEstimateRowToRecord);
}

export function getChatEstimateById(id: number): ChatEstimateRecord | null {
  const row = stmtGetChatEstimateById.get(id) as ChatEstimateRow | undefined;
  return row ? chatEstimateRowToRecord(row) : null;
}

export function getChatEstimatesSince(since: string): ChatEstimateRecord[] {
  return (stmtGetChatEstimatesSince.all(since) as ChatEstimateRow[]).map(chatEstimateRowToRecord);
}

export function deleteChatEstimateRequest(id: number): boolean {
  const result = stmtDeleteChatEstimate.run(id);
  return result.changes > 0;
}

/** Очистка данных для автотестов (Vitest). Не вызывать в продакшене. */
export function clearDatabaseForTests(): void {
  db.exec('DELETE FROM sessions; DELETE FROM chat_estimate_requests; DELETE FROM clients;');
}
