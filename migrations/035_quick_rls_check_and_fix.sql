-- Quick RLS Check and Fix for Chat System
-- Run this in Supabase SQL Editor to verify and fix RLS policies

BEGIN;

-- Check if our safe policies exist
SELECT
    schemaname,
    tablename,
    policyname,
    cmd,
    roles,
    qual,
    with_check
FROM pg_policies
WHERE schemaname = 'public'
AND tablename IN ('chat_conversations', 'chat_participants', 'chat_messages', 'message_status')
ORDER BY tablename, policyname;

-- If the above query shows old policies, run the comprehensive fix again
-- Drop ALL existing RLS policies first
DROP POLICY IF EXISTS "Users can view conversations they participate in" ON public.chat_conversations;
DROP POLICY IF EXISTS "Users can create conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Participants can update conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Allow conversation creation" ON public.chat_conversations;
DROP POLICY IF EXISTS "Allow viewing conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Allow updating own conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Allow deleting own conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Users can create AI conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "safe_view_conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "safe_create_conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "safe_update_conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "safe_delete_conversations" ON public.chat_conversations;

DROP POLICY IF EXISTS "Users can view participants in their conversations" ON public.chat_participants;
DROP POLICY IF EXISTS "Users can join conversations" ON public.chat_participants;
DROP POLICY IF EXISTS "Users can update their own participation" ON public.chat_participants;
DROP POLICY IF EXISTS "Users can view their own participation" ON public.chat_participants;
DROP POLICY IF EXISTS "Users can view other participants" ON public.chat_participants;
DROP POLICY IF EXISTS "Users can add themselves as participants" ON public.chat_participants;
DROP POLICY IF EXISTS "AI conversation creators can add AI participants" ON public.chat_participants;
DROP POLICY IF EXISTS "AI conversations can have system participants" ON public.chat_participants;
DROP POLICY IF EXISTS "Allow participant creation" ON public.chat_participants;
DROP POLICY IF EXISTS "Allow viewing participants" ON public.chat_participants;
DROP POLICY IF EXISTS "Allow updating own participation" ON public.chat_participants;
DROP POLICY IF EXISTS "Allow removing participants" ON public.chat_participants;
DROP POLICY IF EXISTS "safe_view_own_participation" ON public.chat_participants;
DROP POLICY IF EXISTS "safe_add_participants" ON public.chat_participants;
DROP POLICY IF EXISTS "safe_update_own_participation" ON public.chat_participants;
DROP POLICY IF EXISTS "safe_remove_participants" ON public.chat_participants;

DROP POLICY IF EXISTS "Users can view messages in their conversations" ON public.chat_messages;
DROP POLICY IF EXISTS "Users can send messages to their conversations" ON public.chat_messages;
DROP POLICY IF EXISTS "Users can update their own messages" ON public.chat_messages;
DROP POLICY IF EXISTS "safe_view_messages" ON public.chat_messages;
DROP POLICY IF EXISTS "safe_send_messages" ON public.chat_messages;
DROP POLICY IF EXISTS "safe_update_messages" ON public.chat_messages;
DROP POLICY IF EXISTS "safe_delete_messages" ON public.chat_messages;

DROP POLICY IF EXISTS "Users can view message status for their messages" ON public.message_status;
DROP POLICY IF EXISTS "Users can update message status" ON public.message_status;
DROP POLICY IF EXISTS "Users can update their message status" ON public.message_status;
DROP POLICY IF EXISTS "safe_view_message_status" ON public.message_status;
DROP POLICY IF EXISTS "safe_create_message_status" ON public.message_status;
DROP POLICY IF EXISTS "safe_update_message_status" ON public.message_status;

-- Create SIMPLE, WORKING policies
-- CHAT_CONVERSATIONS - Basic creator-only policies
CREATE POLICY "conversations_select" ON public.chat_conversations
    FOR SELECT USING (created_by = auth.uid());

CREATE POLICY "conversations_insert" ON public.chat_conversations
    FOR INSERT WITH CHECK (created_by = auth.uid());

CREATE POLICY "conversations_update" ON public.chat_conversations
    FOR UPDATE USING (created_by = auth.uid())
    WITH CHECK (created_by = auth.uid());

CREATE POLICY "conversations_delete" ON public.chat_conversations
    FOR DELETE USING (created_by = auth.uid());

-- CHAT_PARTICIPANTS - Self-only policies
CREATE POLICY "participants_select" ON public.chat_participants
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "participants_insert" ON public.chat_participants
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "participants_update" ON public.chat_participants
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "participants_delete" ON public.chat_participants
    FOR DELETE USING (user_id = auth.uid());

-- CHAT_MESSAGES - Sender-only policies
CREATE POLICY "messages_select" ON public.chat_messages
    FOR SELECT USING (sender_id = auth.uid());

CREATE POLICY "messages_insert" ON public.chat_messages
    FOR INSERT WITH CHECK (sender_id = auth.uid());

CREATE POLICY "messages_update" ON public.chat_messages
    FOR UPDATE USING (sender_id = auth.uid())
    WITH CHECK (sender_id = auth.uid());

CREATE POLICY "messages_delete" ON public.chat_messages
    FOR DELETE USING (sender_id = auth.uid());

-- MESSAGE_STATUS - User-only policies
CREATE POLICY "message_status_select" ON public.message_status
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "message_status_insert" ON public.message_status
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "message_status_update" ON public.message_status
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

COMMIT;