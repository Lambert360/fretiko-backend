-- Add RLS policy to allow users to update reactions on messages in their conversations
-- This allows any participant in a conversation to add/remove reactions

BEGIN;

-- Drop existing update policy if it exists
DROP POLICY IF EXISTS "Users can update reactions on messages in their conversations" ON chat_messages;

-- Create new policy for updating reactions
-- Allow users to update the reactions field if they are a participant in the conversation
CREATE POLICY "Users can update reactions on messages in their conversations"
ON chat_messages
FOR UPDATE
USING (
  EXISTS (
    SELECT 1
    FROM chat_participants
    WHERE chat_participants.conversation_id = chat_messages.conversation_id
      AND chat_participants.user_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM chat_participants
    WHERE chat_participants.conversation_id = chat_messages.conversation_id
      AND chat_participants.user_id = auth.uid()
  )
);

COMMIT;
