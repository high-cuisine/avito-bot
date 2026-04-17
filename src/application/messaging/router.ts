import type { AvitoMessage, AvitoChat } from '../../integrations/avito/client.js';

export interface MessageHandler {
  match: (text: string, msg: AvitoMessage, chat?: AvitoChat) => boolean | Promise<boolean>;
  reply: (text: string, msg: AvitoMessage, chat?: AvitoChat) => string | Promise<string>;
}

const handlers: MessageHandler[] = [];

export function addHandler(handler: MessageHandler): void {
  handlers.push(handler);
}

export async function processMessage(
  text: string,
  message: AvitoMessage,
  chat?: AvitoChat,
): Promise<string | null> {
  for (const handler of handlers) {
    const matched = await handler.match(text, message, chat);
    if (matched) return handler.reply(text, message, chat);
  }
  return null;
}

export function addRegexHandler(
  regex: RegExp,
  replyTemplate: string | ((match: RegExpMatchArray | null) => string),
): void {
  addHandler({
    match: (text) => regex.test(text),
    reply: (text) => {
      const m = text.match(regex);
      if (typeof replyTemplate === 'function') return replyTemplate(m);
      return replyTemplate.replace(/\$(\d+)/g, (_, i: string) => m?.[+i] ?? '');
    },
  });
}
