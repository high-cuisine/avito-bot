import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

const FILES = {
  base: '00-base.md',
  firstMessage: '10-first-message.md',
  withPhone: '20-with-phone.md',
  withoutPhone: '30-without-phone.md',
} as const;

let cachedBase = '';
let cachedFirstMessage = '';
let cachedWithPhoneDoc = '';
let cachedWithoutPhoneDoc = '';

function readUtf8(filePath: string): string {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return '';
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to read prompt file');
    return '';
  }
}

export function loadSystemPromptsFromDisk(): void {
  const dir = config.promptsDir;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    logger.warn({ dir }, 'PROMPTS_DIR missing or not a directory; LLM runs without prompt MD files');
    cachedBase = '';
    cachedFirstMessage = '';
    cachedWithPhoneDoc = '';
    cachedWithoutPhoneDoc = '';
    return;
  }

  cachedBase = readUtf8(path.join(dir, FILES.base));
  cachedFirstMessage = readUtf8(path.join(dir, FILES.firstMessage));
  cachedWithPhoneDoc = readUtf8(path.join(dir, FILES.withPhone));
  cachedWithoutPhoneDoc = readUtf8(path.join(dir, FILES.withoutPhone));

  const missing = [
    !cachedBase && FILES.base,
    !cachedFirstMessage && FILES.firstMessage,
    !cachedWithPhoneDoc && FILES.withPhone,
    !cachedWithoutPhoneDoc && FILES.withoutPhone,
  ].filter(Boolean);
  if (missing.length > 0) {
    logger.warn({ dir, missing }, 'Some prompt files are empty or missing');
  } else {
    logger.info({ dir }, 'System prompt MD files loaded');
  }
}

export function getBasePrompt(): string {
  return cachedBase;
}

export function getFirstMessagePrompt(): string {
  return cachedFirstMessage;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Возвращает содержимое под `## {sectionTitle}` до следующего `##` (включая заголовок секции).
 * Пустая строка, если секция не найдена.
 */
export function extractSectionFromDoc(full: string, sectionTitle: string): string {
  const t = full.trim();
  if (!t) return '';
  const re = new RegExp(`^##\\s+${escapeRe(sectionTitle)}\\s*$`, 'm');
  const m = t.match(re);
  if (!m || m.index === undefined) return '';
  const start = m.index + m[0].length;
  const rest = t.slice(start);
  const next = rest.search(/^\s*##\s+/m);
  const body = (next === -1 ? rest : rest.slice(0, next)).trim();
  return `## ${sectionTitle}\n\n${body}`.trim();
}

/**
 * Прямая часть до первого `##` + одна выбранная секция (для сокращения «шума» соседних разделов).
 */
export function extractPreambleAndSection(full: string, sectionTitle: string): string {
  const t = full.trim();
  if (!t) return '';
  const lines = t.split('\n');
  const firstH2 = lines.findIndex((l) => /^\s*##\s+/.test(l));
  const preamble = firstH2 > 0 ? lines.slice(0, firstH2).join('\n').trim() : '';
  const section = extractSectionFromDoc(t, sectionTitle);
  if (!section) {
    return preamble || t;
  }
  return [preamble, section].filter(Boolean).join('\n\n');
}

export function getWithPhoneScenarioBlock(mode: 'survey' | 'phone_backfill' | 'engaged'): string {
  return extractPreambleAndSection(cachedWithPhoneDoc, mode);
}

export function getWithoutPhoneScenarioBlock(mode: 'survey_estimate_only' | 'estimate_wait'): string {
  return extractPreambleAndSection(cachedWithoutPhoneDoc, mode);
}
