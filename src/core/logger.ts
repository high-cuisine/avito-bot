import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = isDev
  ? pino({
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
      },
    })
  : pino({ level: 'info' });
