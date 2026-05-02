import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../../core/logger.js';
import {
  getRuntimeMode,
  setRuntimeMode,
  isTelegramUserAllowed,
  getTelegramAllowedUsers,
  addTelegramAllowedUser,
  removeTelegramAllowedUser,
  type RuntimeMode,
} from '../../infrastructure/storage/repository.js';

function parseMode(text: string): RuntimeMode | null {
  const normalized = text.toLowerCase().trim();
  if (normalized === '/test' || normalized === '/mode_test') return 'test';
  if (normalized === '/prod' || normalized === '/mode_prod') return 'prod';
  return null;
}

export function startTelegramControlBot(): void {
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) {
    logger.info('TELEGRAM_BOT_TOKEN is not set; Telegram control bot is disabled');
    return;
  }

  const bot = new TelegramBot(token, { polling: true });

  bot.onText(/^\/start(?:@\S+)?$/, async (msg) => {
    const userId = String(msg.from?.id ?? '');
    if (!userId || !isTelegramUserAllowed(userId)) {
      await bot.sendMessage(msg.chat.id, 'Доступ запрещён.');
      return;
    }
    const mode = getRuntimeMode();
    await bot.sendMessage(
      msg.chat.id,
      [
        'Панель управления активна.',
        `Текущий режим: ${mode.toUpperCase()}`,
        '',
        'Режим: /mode, /test, /prod',
        'Доступ к боту: /allow_list — список',
        '/allow_add <telegram_id> — добавить',
        '/allow_remove <telegram_id> — убрать из списка',
      ].join('\n'),
    );
  });

  bot.onText(/^\/mode(?:@\S+)?$/, async (msg) => {
    const userId = String(msg.from?.id ?? '');
    if (!userId || !isTelegramUserAllowed(userId)) {
      await bot.sendMessage(msg.chat.id, 'Доступ запрещён.');
      return;
    }
    const mode = getRuntimeMode();
    await bot.sendMessage(msg.chat.id, `Текущий режим: ${mode.toUpperCase()}`);
  });

  bot.onText(/^\/allow_list(?:@\S+)?$/, async (msg) => {
    const userId = String(msg.from?.id ?? '');
    if (!userId || !isTelegramUserAllowed(userId)) {
      await bot.sendMessage(msg.chat.id, 'Доступ запрещён.');
      return;
    }
    const ids = getTelegramAllowedUsers();
    const body =
      ids.length === 0
        ? 'Список пуст (ни у кого нет доступа к боту).'
        : `Разрешённые telegram_id (${ids.length}):\n${ids.join('\n')}`;
    await bot.sendMessage(msg.chat.id, body);
  });

  bot.onText(/^\/allow_add(?:@\S+)?\s+(\d+)\s*$/, async (msg, match) => {
    const userId = String(msg.from?.id ?? '');
    if (!userId || !isTelegramUserAllowed(userId)) {
      await bot.sendMessage(msg.chat.id, 'Доступ запрещён.');
      return;
    }
    const target = match?.[1] ?? '';
    if (!target) {
      await bot.sendMessage(msg.chat.id, 'Укажите числовой telegram_id: /allow_add 123456789');
      return;
    }
    if (isTelegramUserAllowed(target)) {
      await bot.sendMessage(msg.chat.id, `Уже в списке: ${target}`);
      return;
    }
    addTelegramAllowedUser(target);
    await bot.sendMessage(msg.chat.id, `Добавлен доступ для ${target}.`);
    logger.info({ byUserId: userId, added: target }, 'Telegram allowlist: user added');
  });

  bot.onText(/^\/allow_remove(?:@\S+)?\s+(\d+)\s*$/, async (msg, match) => {
    const userId = String(msg.from?.id ?? '');
    if (!userId || !isTelegramUserAllowed(userId)) {
      await bot.sendMessage(msg.chat.id, 'Доступ запрещён.');
      return;
    }
    const target = match?.[1] ?? '';
    if (!target) {
      await bot.sendMessage(msg.chat.id, 'Укажите telegram_id: /allow_remove 123456789');
      return;
    }
    const list = getTelegramAllowedUsers();
    if (list.length <= 1) {
      await bot.sendMessage(
        msg.chat.id,
        'Нельзя удалить последнего пользователя из списка — иначе никто не сможет управлять ботом.',
      );
      return;
    }
    if (!isTelegramUserAllowed(target)) {
      await bot.sendMessage(msg.chat.id, `Нет в списке: ${target}`);
      return;
    }
    const removed = removeTelegramAllowedUser(target);
    if (!removed) {
      await bot.sendMessage(msg.chat.id, 'Не удалось удалить.');
      return;
    }
    await bot.sendMessage(msg.chat.id, `Удалён из списка: ${target}.`);
    logger.info({ byUserId: userId, removed: target }, 'Telegram allowlist: user removed');
  });

  bot.on('message', async (msg) => {
    const text = msg.text?.trim();
    if (!text || text === '/start' || text === '/mode') return;

    const userId = String(msg.from?.id ?? '');
    if (!userId || !isTelegramUserAllowed(userId)) {
      await bot.sendMessage(msg.chat.id, 'Доступ запрещён.');
      return;
    }

    const nextMode = parseMode(text);
    if (!nextMode) return;

    const current = getRuntimeMode();
    if (current === nextMode) {
      await bot.sendMessage(msg.chat.id, `Режим уже ${current.toUpperCase()}.`);
      return;
    }

    const saved = setRuntimeMode(nextMode);
    await bot.sendMessage(msg.chat.id, `Режим переключен на ${saved.toUpperCase()}.`);
    logger.info({ userId, mode: saved }, 'Runtime mode switched from Telegram');
  });

  bot.on('polling_error', (err) => {
    logger.error({ err }, 'Telegram control bot polling error');
  });

  logger.info('Telegram control bot started');
}
