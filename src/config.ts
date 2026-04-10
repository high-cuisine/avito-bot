import 'dotenv/config';

export interface AvitoConfig {
  clientId: string;
  clientSecret: string;
  userId: string | null;
  baseUrl: string;
}

export interface Config {
  avito: AvitoConfig;
  mode: 'polling' | 'webhook';
  pollIntervalSec: number;
  webhook: {
    port: number;
    url: string;
  };
}

export const config: Config = {
  avito: {
    clientId: process.env.AVITO_CLIENT_ID ?? '',
    clientSecret: process.env.AVITO_CLIENT_SECRET ?? '',
    userId: process.env.AVITO_USER_ID || null,
    baseUrl: 'https://api.avito.ru',
  },
  mode: (process.env.MODE as Config['mode']) || 'polling',
  pollIntervalSec: parseInt(process.env.POLL_INTERVAL_SEC ?? '15', 10),
  webhook: {
    port: parseInt(process.env.WEBHOOK_PORT ?? '3000', 10),
    url: process.env.WEBHOOK_URL ?? '',
  },
};

export function validateConfig(): void {
  if (!config.avito.clientId || !config.avito.clientSecret) {
    throw new Error('AVITO_CLIENT_ID and AVITO_CLIENT_SECRET must be set in .env');
  }
}
