-- Clean up duplicate conversations and add unique constraint
-- This ensures same participants + chat_type = one conversation

BEGIN;

-- Step 1: Identify and keep only the most recent conversation for each hash+type combination
WITH duplicates AS (
  SELECT
    participant_hash,
    chat_type,
    id,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY participant_hash, chat_type
      ORDER BY created_at DESC
    ) as rn
  FROM public.chat_conversations
  WHERE participant_hash IS NOT NULL
),
conversations_to_delete AS (
  SELECT id FROM duplicates WHERE rn > 1
)

-- Delete duplicate conversations (keep only the most recent one per hash+type)
DELETE FROM public.chat_conversations
WHERE id IN (SELECT id FROM conversations_to_delete);

-- Step 2: Clean up orphaned participants and messages
DELETE FROM public.chat_participants
WHERE conversation_id NOT IN (SELECT id FROM public.chat_conversations);

DELETE FROM public.chat_messages
WHERE conversation_id NOT IN (SELECT id FROM public.chat_conversations);

-- Step 3: Add unique constraint now that duplicates are cleaned
ALTER TABLE public.chat_conversations
ADD CONSTRAINT unique_participant_hash_chat_type
UNIQUE (participant_hash, chat_type);

COMMIT;