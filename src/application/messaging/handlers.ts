import { addHandler } from './router.js';
import { handleConversation } from '../conversation/service.js';

addHandler({
  match: () => true,
  reply: (text, msg, chat) => handleConversation(chat?.id ?? msg.chat_id, text, chat),
});
