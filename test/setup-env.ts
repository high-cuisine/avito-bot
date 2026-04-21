/**
 * Выполняется до загрузки тестовых модулей: in-memory SQLite и токен API для supertest.
 */
process.env.DB_PATH = ':memory:';
process.env.API_TOKEN = 'vitest-api-secret-token';
