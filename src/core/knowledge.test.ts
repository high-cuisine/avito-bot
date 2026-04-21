import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('knowledge', () => {
  const prevDir = process.env.KNOWLEDGE_DIR;

  afterEach(() => {
    if (prevDir === undefined) delete process.env.KNOWLEDGE_DIR;
    else process.env.KNOWLEDGE_DIR = prevDir;
    vi.resetModules();
  });

  it('loadKnowledgeFromDisk concatenates markdown', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avito-know-'));
    fs.writeFileSync(path.join(dir, '01-topic.md'), '# Заголовок\n\nТекст раздела.', 'utf8');

    process.env.KNOWLEDGE_DIR = dir;
    vi.resetModules();
    const { loadKnowledgeFromDisk, getKnowledgeBundle } = await import('./knowledge.js');
    loadKnowledgeFromDisk();
    const bundle = getKnowledgeBundle();
    expect(bundle).toContain('01-topic.md');
    expect(bundle).toContain('Текст раздела');
    expect(bundle).toContain('База знаний');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips README and underscore drafts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avito-know2-'));
    fs.writeFileSync(path.join(dir, 'README.md'), 'ignored', 'utf8');
    fs.writeFileSync(path.join(dir, '_draft.md'), 'draft', 'utf8');
    fs.writeFileSync(path.join(dir, '02-real.md'), 'real', 'utf8');

    process.env.KNOWLEDGE_DIR = dir;
    vi.resetModules();
    const { loadKnowledgeFromDisk, getKnowledgeBundle } = await import('./knowledge.js');
    loadKnowledgeFromDisk();
    const bundle = getKnowledgeBundle();
    expect(bundle).toContain('02-real');
    expect(bundle).not.toContain('README');
    expect(bundle).not.toContain('draft');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
