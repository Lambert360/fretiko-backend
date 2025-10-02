-- Test and Fix Message History Retrieval
-- Run this in Supabase SQL Editor to debug message history issues

BEGIN;

-- Test the is_conversation_participant function
-- Replace these UUIDs with actual values from your database for testing
-- SELECT is_conversation_participant('your-conversation-id', 'your-user-id');

-- Check if RLS is blocking message retrieval
-- Temporarily create a more permissive policy for testing
DROP POLICY IF EXISTS "chat_messages_select" ON public.chat_messages;

-- Create a temporary, very permissive policy to test if RLS is the issue
CREATE POLICY "debug_chat_messages_select" ON public.chat_messages
    FOR SELECT USING (
        true -- Allow viewing ALL messages temporarily for debugging
    );

-- After testing with this policy, we'll know if RLS is the problem
-- If messages show up with this policy, then the issue is with our participant check
-- If messages still don't show up, the issue is elsewhere (frontend, API, etc.)

COMMIT;

-- TO RESTORE PROPER POLICY AFTER TESTING:
-- DROP POLICY IF EXISTS "debug_chat_messages_select" ON public.chat_messages;
-- CREATE POLICY "chat_messages_select" ON public.chat_messages
--     FOR SELECT USING (
--         sender_id = auth.uid() OR
--         is_conversation_participant(conversation_id, auth.uid())
--     );