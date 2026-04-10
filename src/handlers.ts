import { addHandler } from './pattern-handler.js';
import { handleConversation } from './conversation.js';

addHandler({
  match: () => true,
  reply: (_text, msg, chat) => handleConversation(msg.chat_id, _text, chat),
});
