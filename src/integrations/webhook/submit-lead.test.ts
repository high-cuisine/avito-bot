import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('postSubmitWebhook', () => {
  const originalUrl = process.env.SUBMIT_WEBHOOK_URL;
  const originalSecret = process.env.SUBMIT_WEBHOOK_SECRET;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.SUBMIT_WEBHOOK_URL;
    delete process.env.SUBMIT_WEBHOOK_SECRET;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalUrl === undefined) delete process.env.SUBMIT_WEBHOOK_URL;
    else process.env.SUBMIT_WEBHOOK_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.SUBMIT_WEBHOOK_SECRET;
    else process.env.SUBMIT_WEBHOOK_SECRET = originalSecret;
  });

  it('returns true when URL not set', async () => {
    const { postSubmitWebhook } = await import('./submit-lead.js');
    const ok = await postSubmitWebhook({
      event: 'transport_lead',
      chat_id: 'c1',
      item_id: null,
      client_name: null,
      cargo: 'x',
      route: 'a—b',
      payment_method: 'нал',
      phone: '+79000000000',
      submitted_at: new Date().toISOString(),
    });
    expect(ok).toBe(true);
  });

  it('POSTs JSON and returns true on 200', async () => {
    process.env.SUBMIT_WEBHOOK_URL = 'https://example.com/hook';
    process.env.SUBMIT_WEBHOOK_SECRET = 'secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '',
      }),
    );

    const { postSubmitWebhook } = await import('./submit-lead.js');
    const ok = await postSubmitWebhook({
      event: 'chat_estimate',
      chat_id: 'c2',
      item_id: '1',
      client_name: 'Ann',
      cargo: 'boxes',
      route: 'A—B',
      payment_method: 'card',
      phone: null,
      details: 'extra',
      submitted_at: '2026-01-01T00:00:00.000Z',
    });

    expect(ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://example.com/hook');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    const body = JSON.parse(String(init.body));
    expect(body.event).toBe('chat_estimate');
    expect(body.details).toBe('extra');
    expect(body.phone).toBeNull();
  });

  it('returns false on non-OK response', async () => {
    process.env.SUBMIT_WEBHOOK_URL = 'https://example.com/hook';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'err',
      }),
    );

    const { postSubmitWebhook } = await import('./submit-lead.js');
    const ok = await postSubmitWebhook({
      event: 'phone_backfill',
      chat_id: 'c3',
      item_id: null,
      client_name: null,
      cargo: null,
      route: null,
      payment_method: null,
      phone: '+79001112233',
      submitted_at: new Date().toISOString(),
    });
    expect(ok).toBe(false);
  });

  it('returns false when fetch throws', async () => {
    process.env.SUBMIT_WEBHOOK_URL = 'https://example.com/hook';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));

    const { postSubmitWebhook } = await import('./submit-lead.js');
    const ok = await postSubmitWebhook({
      event: 'transport_lead',
      chat_id: 'c4',
      item_id: null,
      client_name: null,
      cargo: 'x',
      route: 'a—b',
      payment_method: 'нал',
      phone: '+79000000000',
      submitted_at: new Date().toISOString(),
    });
    expect(ok).toBe(false);
  });
});
