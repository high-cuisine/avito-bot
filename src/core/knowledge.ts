import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

let cachedBundle = '';

function isMarkdownFile(name: string): boolean {
  if (!name.endsWith('.md') || name.startsWith('.')) return false;
  const lower = name.toLowerCase();
  if (lower === 'readme.md') return false;
  return true;
}

/**
 * Читает все `*.md` в каталоге (без подпапок), по имени файла по алфавиту.
 * Файлы с префиксом `_` в имени пропускаются (черновики).
 */
export function loadKnowledgeFromDisk(): void {
  const dir = config.knowledgeDir;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    logger.warn({ dir }, 'Knowledge directory missing; bot runs without MD knowledge');
    cachedBundle = '';
    return;
  }

  const names = fs
    .readdirSync(dir)
    .filter((f) => isMarkdownFile(f) && !f.startsWith('_'))
    .sort((a, b) => a.localeCompare(b, 'ru'));

  const chunks: string[] = [];
  for (const name of names) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    const body = fs.readFileSync(full, 'utf8').trim();
    if (!body) continue;
    chunks.push(`## ${name}\n\n${body}`);
  }

  if (chunks.length === 0) {
    logger.warn({ dir }, 'Knowledge directory has no readable .md files');
    cachedBundle = '';
    return;
  }

  cachedBundle = [
    '# База знаний',
    '',
    'Ниже — материалы компании: роль агента, товар/услуга, политики. Учитывай их в ответах, не противоречь им.',
    '',
    ...chunks,
  ].join('\n\n');

  logger.info({ dir, fileCount: names.length }, 'Knowledge MD bundle loaded');
}

/** Сконкатенированный текст всех `.md` из каталога знаний (пустая строка, если не загружено). */
export function getKnowledgeBundle(): string {
  return cachedBundle;
}
