-- Debug Message Insert Issues
-- Test if messages are actually being stored
-- Run this in Supabase SQL Editor

BEGIN;

-- Check current message insert policy
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
AND tablename = 'chat_messages'
AND cmd = 'INSERT';

-- Temporarily make message insert very permissive for debugging
DROP POLICY IF EXISTS "chat_messages_insert" ON public.chat_messages;

-- Create debug insert policy that allows any authenticated user to insert
CREATE POLICY "debug_chat_messages_insert" ON public.chat_messages
    FOR INSERT WITH CHECK (
        sender_id = auth.uid() -- Only requirement: sender must be the authenticated user
    );

-- Also check if there are any messages in the database at all
-- (You can run this separately)
-- SELECT count(*) FROM public.chat_messages;
-- SELECT * FROM public.chat_messages ORDER BY created_at DESC LIMIT 10;

COMMIT;

-- After testing, restore proper policy:
-- DROP POLICY IF EXISTS "debug_chat_messages_insert" ON public.chat_messages;
-- CREATE POLICY "chat_messages_insert" ON public.chat_messages
--     FOR INSERT WITH CHECK (
--         sender_id = auth.uid() AND
--         is_conversation_participant(conversation_id, auth.uid())
--     );