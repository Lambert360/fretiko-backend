-- Temporarily make ALL policies very permissive to test message retrieval
-- Run this in Supabase SQL Editor

BEGIN;

-- Drop current restrictive policies
DROP POLICY IF EXISTS "chat_messages_select" ON public.chat_messages;
DROP POLICY IF EXISTS "chat_messages_insert" ON public.chat_messages;

-- Create very permissive policies for testing
CREATE POLICY "debug_messages_select_all" ON public.chat_messages
    FOR SELECT USING (true); -- Allow viewing ALL messages

CREATE POLICY "debug_messages_insert_all" ON public.chat_messages
    FOR INSERT WITH CHECK (sender_id = auth.uid()); -- Only require sender to be authenticated user

COMMIT;

-- After testing, restore proper policies by running:
-- DROP POLICY IF EXISTS "debug_messages_select_all" ON public.chat_messages;
-- DROP POLICY IF EXISTS "debug_messages_insert_all" ON public.chat_messages;
--
-- CREATE POLICY "chat_messages_select" ON public.chat_messages
--     FOR SELECT USING (
--         sender_id = auth.uid() OR
--         is_conversation_participant(conversation_id, auth.uid())
--     );
--
-- CREATE POLICY "chat_messages_insert" ON public.chat_messages
--     FOR INSERT WITH CHECK (
--         sender_id = auth.uid() AND
--         is_conversation_participant(conversation_id, auth.uid())
--     );