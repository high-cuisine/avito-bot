/**
 * Выполняется до загрузки тестовых модулей: in-memory SQLite и токен API для supertest.
 */
process.env.DB_PATH = ':memory:';
process.env.API_TOKEN = 'vitest-api-secret-token';
process.env.ADMIN_LOGIN = 'testadmin';
process.env.ADMIN_PASSWORD = 'test-admin-pass';
process.env.ADMIN_SESSION_SECRET = 'vitest-admin-session-secret';
