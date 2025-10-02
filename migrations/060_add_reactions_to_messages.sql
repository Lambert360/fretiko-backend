-- Add reactions column to chat_messages table
-- This stores emoji reactions as a JSONB object with format: { "emoji": ["userId1", "userId2"] }

BEGIN;

-- Add reactions column if it doesn't exist
ALTER TABLE chat_messages
ADD COLUMN IF NOT EXISTS reactions JSONB DEFAULT '{}'::jsonb;

-- Create index for faster reaction queries
CREATE INDEX IF NOT EXISTS idx_chat_messages_reactions
ON chat_messages USING GIN (reactions);

COMMIT;
