/**
 * Подмена `bun:sqlite` в Vitest (Node): API совместим с использованием в repository.ts.
 */
import BetterSqlite3 from 'better-sqlite3';

export const Database = BetterSqlite3;
