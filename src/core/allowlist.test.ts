import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('allowlist', () => {
  beforeEach(() => {
    vi.resetModules();
    // Пустая строка блокирует подстановку из .env при `delete` ключ снова появлялся из файла.
    process.env.ALLOWLIST_CHAT_IDS = '';
    process.env.ALLOWLIST_USER_IDS = '';
  });

  it('allowlistActive is false when lists empty', async () => {
    const { allowlistActive } = await import('./allowlist.js');
    expect(allowlistActive()).toBe(false);
  });

  it('allows any when lists empty', async () => {
    const { isSenderAllowlisted } = await import('./allowlist.js');
    expect(isSenderAllowlisted('chat-1', '999')).toBe(true);
  });

  it('chat-only allowlist', async () => {
    process.env.ALLOWLIST_CHAT_IDS = 'a,b';
    vi.resetModules();
    const { isSenderAllowlisted, allowlistActive } = await import('./allowlist.js');
    expect(allowlistActive()).toBe(true);
    expect(isSenderAllowlisted('a', 'u1')).toBe(true);
    expect(isSenderAllowlisted('b', 'u2')).toBe(true);
    expect(isSenderAllowlisted('c', 'u1')).toBe(false);
  });

  it('user-only allowlist', async () => {
    process.env.ALLOWLIST_USER_IDS = '10,20';
    vi.resetModules();
    const { isSenderAllowlisted } = await import('./allowlist.js');
    expect(isSenderAllowlisted('any-chat', '10')).toBe(true);
    expect(isSenderAllowlisted('any-chat', 20)).toBe(true);
    expect(isSenderAllowlisted('any-chat', '99')).toBe(false);
  });

  it('both lists require AND', async () => {
    process.env.ALLOWLIST_CHAT_IDS = 'c1';
    process.env.ALLOWLIST_USER_IDS = 'u1';
    vi.resetModules();
    const { isSenderAllowlisted } = await import('./allowlist.js');
    expect(isSenderAllowlisted('c1', 'u1')).toBe(true);
    expect(isSenderAllowlisted('c1', 'u2')).toBe(false);
    expect(isSenderAllowlisted('c2', 'u1')).toBe(false);
  });
});
