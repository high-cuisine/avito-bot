import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvitoMessage } from '../../integrations/avito/client.js';

function msg(chatId: string, text: string): AvitoMessage {
  return {
    id: '1',
    author_id: 1,
    chat_id: chatId,
    created: 0,
    type: 'text',
    content: { text },
  };
}

describe('router', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns null when no handler matches', async () => {
    const { processMessage } = await import('./router.js');
    expect(await processMessage('hello', msg('c', 'hello'))).toBeNull();
  });

  it('runs first matching handler', async () => {
    const { addHandler, processMessage } = await import('./router.js');
    addHandler({
      match: (t) => t.startsWith('ping'),
      reply: () => 'pong',
    });
    expect(await processMessage('ping-1', msg('c', 'ping-1'))).toBe('pong');
  });

  it('addRegexHandler replaces groups', async () => {
    const { addRegexHandler, processMessage } = await import('./router.js');
    addRegexHandler(/^code\s+(\d+)$/, (m) => `ok ${m?.[1] ?? ''}`);
    expect(await processMessage('code 42', msg('c', 'code 42'))).toBe('ok 42');
  });
});
