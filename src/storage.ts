import { Database } from 'bun:sqlite';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), 'data.db');

const db = new Database(DB_PATH, { create: true });
db.exec('PRAGMA journal_mode = WAL');

// ─── Schema ───────────────────────────────────────────────────────────────────

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
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─── Session types ────────────────────────────────────────────────────────────

export interface SessionData {
  itemId: string;
  clientName: string;
  cargo: string;
  route: string;
  paymentMethod: string;
}

export interface Session {
  chatId: string;
  state: string;
  data: SessionData;
}

// ─── Session CRUD ─────────────────────────────────────────────────────────────

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

// ─── Client record ────────────────────────────────────────────────────────────

export interface ClientRecord {
  id: number;
  chatId: string;
  itemId: string | null;
  clientName: string | null;
  cargo: string | null;
  route: string | null;
  paymentMethod: string | null;
  createdAt: string;
}

const stmtInsertClient = db.prepare(`
  INSERT INTO clients (chat_id, item_id, client_name, cargo, route, payment_method, created_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(chat_id) DO UPDATE SET item_id        = excluded.item_id,
                                     client_name    = excluded.client_name,
                                     cargo          = excluded.cargo,
                                     route          = excluded.route,
                                     payment_method = excluded.payment_method,
                                     created_at     = excluded.created_at
`);

const stmtGetClients = db.prepare(
  'SELECT id, chat_id, item_id, client_name, cargo, route, payment_method, created_at FROM clients ORDER BY id DESC',
);

export function saveClient(data: SessionData & { chatId: string }): void {
  stmtInsertClient.run(
    data.chatId,
    data.itemId || null,
    data.clientName || null,
    data.cargo || null,
    data.route || null,
    data.paymentMethod || null,
  );
}

export function getClients(): ClientRecord[] {
  const rows = stmtGetClients.all() as Array<{
    id: number;
    chat_id: string;
    item_id: string | null;
    client_name: string | null;
    cargo: string | null;
    route: string | null;
    payment_method: string | null;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    chatId: r.chat_id,
    itemId: r.item_id,
    clientName: r.client_name,
    cargo: r.cargo,
    route: r.route,
    paymentMethod: r.payment_method,
    createdAt: r.created_at,
  }));
}
