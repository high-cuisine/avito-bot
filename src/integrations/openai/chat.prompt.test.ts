import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prevKnow = process.env.KNOWLEDGE_DIR;
const prevPrompts = process.env.PROMPTS_DIR;

describe('buildSystemPrompt branch isolation', () => {
  beforeEach(async () => {
    vi.resetModules();
    const root = process.cwd();
    process.env.KNOWLEDGE_DIR = path.join(root, 'knowledge');
    process.env.PROMPTS_DIR = path.join(root, 'prompts');
    const { loadKnowledgeFromDisk } = await import('../../core/knowledge.js');
    const { loadSystemPromptsFromDisk } = await import('../../core/prompts.js');
    loadSystemPromptsFromDisk();
    loadKnowledgeFromDisk();
  });

  afterEach(() => {
    if (prevKnow === undefined) delete process.env.KNOWLEDGE_DIR;
    else process.env.KNOWLEDGE_DIR = prevKnow;
    if (prevPrompts === undefined) delete process.env.PROMPTS_DIR;
    else process.env.PROMPTS_DIR = prevPrompts;
  });

  it('survey_estimate_only: no +7, no other-branch tool names, no "запрещено" from old without-phone phrasing in knowledge', async () => {
    const { buildSystemPrompt } = await import('./chat.js');
    const s = buildSystemPrompt({
      chatMode: 'survey_estimate_only',
      chatId: 'c1',
      clientName: 'Тест',
      itemId: 'i1',
    });
    expect(s).not.toMatch(/\+7/);
    expect(s).not.toMatch(/submit_transport_lead/);
    expect(s).not.toMatch(/declare_phone_contact_path/);
    // старый конфликт: «запрещено просить» из product/knowledge не должен быть вставлен как единая инструкция
    expect(s).not.toMatch(/ЗАПРЕЩЕНО/);
  });

  it('estimate_wait: no +7 in system prompt', async () => {
    const { buildSystemPrompt } = await import('./chat.js');
    const s = buildSystemPrompt({
      chatMode: 'estimate_wait',
      chatId: 'c2',
      clientName: 'Олег',
      itemId: 'i2',
    });
    expect(s).not.toMatch(/\+7/);
  });

  it('phone_intent: no lead/estimate tool instructions in first-line branch', async () => {
    const { buildSystemPrompt } = await import('./chat.js');
    const s = buildSystemPrompt({
      chatMode: 'phone_intent',
      chatId: 'c3',
      clientName: 'Аня',
      itemId: 'i3',
    });
    expect(s).not.toMatch(/submit_transport_lead/);
    expect(s).not.toMatch(/submit_chat_estimate_request/);
  });

  it('survey: does not smuggle the old "ЗАПРЕЩЕНО" without-phone line from 30 doc', async () => {
    const { buildSystemPrompt } = await import('./chat.js');
    const s = buildSystemPrompt({
      chatMode: 'survey',
      chatId: 'c4',
      clientName: 'Павел',
      itemId: 'i4',
    });
    expect(s).toMatch(/submit_transport_lead/);
    expect(s).not.toMatch(/ЗАПРЕЩЕНО/);
  });
});
