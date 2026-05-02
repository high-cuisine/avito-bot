import crypto from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { getRuntimeMode, setRuntimeMode } from '../../infrastructure/storage/repository.js';

const COOKIE_NAME = 'avito_admin_sess';

function sessionSecret(): string {
  const s = config.admin.sessionSecret || config.api.token;
  if (!s) {
    logger.warn(
      'ADMIN_SESSION_SECRET и API_TOKEN пусты — cookie админки подписаны слабым fallback (только для dev)',
    );
    return 'avito-admin-insecure-fallback';
  }
  return s;
}

function createSessionValue(): string {
  const exp = Date.now() + 7 * 24 * 3600 * 1000;
  const sig = crypto.createHmac('sha256', sessionSecret()).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
}

function verifySessionValue(raw: string | undefined): boolean {
  if (!raw) return false;
  const [exp, sig] = raw.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(exp).digest('hex');
  try {
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (k !== name) continue;
    return decodeURIComponent(part.slice(i + 1).trim());
  }
  return;
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; --bg: #12141a; --card: #1c1f28; --b: #2a3142; --t: #e8eaef; --a: #6ea8fe; --err: #f87171; }
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; background: var(--bg); color: var(--t); margin: 0; min-height: 100vh; padding: 1.5rem; }
    .card { max-width: 28rem; margin: 2rem auto; background: var(--card); border: 1px solid var(--b); border-radius: 12px; padding: 1.5rem; }
    h1 { font-size: 1.15rem; margin: 0 0 1rem; font-weight: 600; }
    label { display: block; font-size: 0.85rem; margin-bottom: 0.35rem; opacity: 0.9; }
    input[type=text], input[type=password] {
      width: 100%; padding: 0.55rem 0.65rem; border-radius: 8px; border: 1px solid var(--b);
      background: var(--bg); color: var(--t); margin-bottom: 0.9rem;
    }
    button, .btn {
      display: inline-block; padding: 0.55rem 1rem; border-radius: 8px; border: 1px solid var(--b);
      background: #2d3f6b; color: var(--t); cursor: pointer; font-size: 0.9rem; text-decoration: none;
    }
    button[type=submit] { background: var(--a); color: #0b1020; border-color: transparent; font-weight: 600; }
    .err { color: var(--err); font-size: 0.9rem; margin-bottom: 0.75rem; }
    .mode { font-size: 2rem; font-weight: 700; letter-spacing: 0.04em; margin: 0.5rem 0 1rem; }
    .row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 1rem; }
    .hint { font-size: 0.8rem; opacity: 0.65; margin-top: 1rem; }
    .ok { color: #4ade80; font-size: 0.9rem; margin-bottom: 0.75rem; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

function loginPage(error?: string): string {
  const errBlock = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  return layout(
    'Вход — Avito bot',
    `<div class="card">
  <h1>Админка</h1>
  ${errBlock}
  <form method="post" action="/admin/login">
    <label for="login">Логин</label>
    <input id="login" name="login" type="text" autocomplete="username" required/>
    <label for="password">Пароль</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required/>
    <button type="submit">Войти</button>
  </form>
  <p class="hint">Учётные данные задаются в .env (ADMIN_LOGIN, ADMIN_PASSWORD).</p>
</div>`,
  );
}

function dashboardPage(mode: string, flashOk?: string): string {
  const ok = flashOk ? `<p class="ok">${escapeHtml(flashOk)}</p>` : '';
  const m = mode === 'prod' ? 'PROD' : 'TEST';
  return layout(
    'Панель — Avito bot',
    `<div class="card">
  <h1>Режим работы бота</h1>
  ${ok}
  <p>Сейчас:</p>
  <p class="mode">${m}</p>
  <div class="row">
    <form method="post" action="/admin/runtime"><input type="hidden" name="mode" value="test"/><button type="submit">Переключить на TEST</button></form>
    <form method="post" action="/admin/runtime"><input type="hidden" name="mode" value="prod"/><button type="submit">Переключить на PROD</button></form>
  </div>
  <p class="hint"><a class="btn" href="/docs">Swagger / API</a> · <a class="btn" href="/admin/logout">Выйти</a></p>
</div>`,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function requireAdminSession(req: Request, res: Response, next: NextFunction): void {
  if (!verifySessionValue(readCookie(req, COOKIE_NAME))) {
    res.status(401).send(loginPage('Сессия истекла. Войдите снова.'));
    return;
  }
  next();
}

export function attachAdminPanel(app: Express): void {
  if (!config.admin.enabled) {
    logger.info('Admin panel disabled (set ADMIN_LOGIN and ADMIN_PASSWORD in .env)');
    return;
  }

  app.get('/admin', (req: Request, res: Response) => {
    if (verifySessionValue(readCookie(req, COOKIE_NAME))) {
      res.type('html').send(dashboardPage(getRuntimeMode()));
      return;
    }
    res.type('html').send(loginPage());
  });

  app.post('/admin/login', (req: Request, res: Response) => {
    const login = String(req.body?.login ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (login === config.admin.login && password === config.admin.password) {
      const val = createSessionValue();
      res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${encodeURIComponent(val)}; HttpOnly; Path=/admin; Max-Age=${7 * 24 * 3600}; SameSite=Lax`,
      );
      res.redirect(302, '/admin');
      return;
    }
    res.status(401).type('html').send(loginPage('Неверный логин или пароль.'));
  });

  app.get('/admin/logout', (_req: Request, res: Response) => {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=; HttpOnly; Path=/admin; Max-Age=0; SameSite=Lax`,
    );
    res.redirect(302, '/admin');
  });

  app.post('/admin/runtime', requireAdminSession, (req: Request, res: Response) => {
    const raw = String(req.body?.mode ?? '').trim();
    if (raw !== 'test' && raw !== 'prod') {
      res.status(400).type('html').send(layout('Ошибка', `<div class="card"><p class="err">Некорректный режим</p><p><a class="btn" href="/admin">Назад</a></p></div>`));
      return;
    }
    setRuntimeMode(raw);
    logger.info({ mode: raw }, 'Runtime mode switched from admin panel');
    res.type('html').send(dashboardPage(getRuntimeMode(), `Сохранено: ${raw.toUpperCase()}`));
  });
}
