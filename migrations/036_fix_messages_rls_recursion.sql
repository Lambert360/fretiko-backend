-- Fix the recursive RLS policy in chat_messages that's causing the error
-- Run this in Supabase SQL Editor

BEGIN;

-- Drop the problematic message policies
DROP POLICY IF EXISTS "safe_send_messages" ON public.chat_messages;
DROP POLICY IF EXISTS "safe_view_messages" ON public.chat_messages;

-- Create simple, non-recursive message policies
-- For now, allow users to send messages to any conversation they created
-- and view messages from conversations they created or messages they sent
CREATE POLICY "simple_send_messages" ON public.chat_messages
    FOR INSERT WITH CHECK (
        sender_id = auth.uid() AND
        conversation_id IN (
            SELECT id FROM public.chat_conversations
            WHERE created_by = auth.uid()
        )
    );

CREATE POLICY "simple_view_messages" ON public.chat_messages
    FOR SELECT USING (
        sender_id = auth.uid() OR
        conversation_id IN (
            SELECT id FROM public.chat_conversations
            WHERE created_by = auth.uid()
        )
    );

COMMIT;