import { describe, expect, it } from 'vitest';
import type { AvitoChat } from './client.js';
import { formatAllowlistRejectLog, resolveMessengerPeerName } from './peer-label.js';

describe('peer-label', () => {
  it('resolveMessengerPeerName returns dash when unknown', () => {
    expect(resolveMessengerPeerName(undefined, 1)).toBe('—');
  });

  it('resolveMessengerPeerName finds name by author id', () => {
    const chat: AvitoChat = {
      id: 'c',
      users: [
        { id: 10, name: '  Вася  ' },
        { id: 20, name: 'Петя' },
      ],
    };
    expect(resolveMessengerPeerName(chat, 10)).toBe('Вася');
    expect(resolveMessengerPeerName(chat, '20')).toBe('Петя');
  });

  it('formatAllowlistRejectLog', () => {
    const chat: AvitoChat = {
      id: 'x',
      users: [{ id: 5, name: 'Гость' }],
    };
    const line = formatAllowlistRejectLog(chat, 5, 'chat-99');
    expect(line).toContain('Гость');
    expect(line).toContain('chat-99');
    expect(line).toContain('5');
  });
});
