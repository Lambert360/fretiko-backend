BEGIN;

-- Speed up unread COUNT and last-message fetches
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created_at
  ON public.chat_messages(conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_deleted
  ON public.chat_messages(conversation_id, is_deleted);

-- Speed up participant verification and last_read_at lookups
CREATE INDEX IF NOT EXISTS idx_chat_participants_conversation_user
  ON public.chat_participants(conversation_id, user_id);

COMMIT;

