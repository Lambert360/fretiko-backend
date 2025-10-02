-- Force Replace All Chat RLS Policies
-- This will drop ALL existing policies and create new correct ones
-- Run this in Supabase SQL Editor

BEGIN;

-- =====================================================================================
-- STEP 1: FORCE DROP ALL POLICIES (even if names don't match exactly)
-- =====================================================================================

-- Get all policy names for chat tables and drop them
DO $$
DECLARE
    r RECORD;
BEGIN
    -- Drop all policies on chat_conversations
    FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chat_conversations'
    LOOP
        EXECUTE 'DROP POLICY IF EXISTS "' || r.policyname || '" ON public.chat_conversations';
    END LOOP;

    -- Drop all policies on chat_participants
    FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chat_participants'
    LOOP
        EXECUTE 'DROP POLICY IF EXISTS "' || r.policyname || '" ON public.chat_participants';
    END LOOP;

    -- Drop all policies on chat_messages
    FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'chat_messages'
    LOOP
        EXECUTE 'DROP POLICY IF EXISTS "' || r.policyname || '" ON public.chat_messages';
    END LOOP;

    -- Drop all policies on message_status
    FOR r IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'message_status'
    LOOP
        EXECUTE 'DROP POLICY IF EXISTS "' || r.policyname || '" ON public.message_status';
    END LOOP;
END
$$;

-- =====================================================================================
-- STEP 2: CREATE FUNCTION TO CHECK IF USER IS PARTICIPANT
-- =====================================================================================

-- Drop function if exists and recreate
DROP FUNCTION IF EXISTS is_conversation_participant(UUID, UUID);

CREATE OR REPLACE FUNCTION is_conversation_participant(conversation_uuid UUID, user_uuid UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.chat_participants
        WHERE conversation_id = conversation_uuid
        AND user_id = user_uuid
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================================================
-- STEP 3: CHAT_CONVERSATIONS POLICIES
-- =====================================================================================

CREATE POLICY "chat_conversations_select" ON public.chat_conversations
    FOR SELECT USING (
        created_by = auth.uid() OR
        is_conversation_participant(id, auth.uid())
    );

CREATE POLICY "chat_conversations_insert" ON public.chat_conversations
    FOR INSERT WITH CHECK (created_by = auth.uid());

CREATE POLICY "chat_conversations_update" ON public.chat_conversations
    FOR UPDATE USING (created_by = auth.uid())
    WITH CHECK (created_by = auth.uid());

CREATE POLICY "chat_conversations_delete" ON public.chat_conversations
    FOR DELETE USING (created_by = auth.uid());

-- =====================================================================================
-- STEP 4: CHAT_PARTICIPANTS POLICIES
-- =====================================================================================

CREATE POLICY "chat_participants_select" ON public.chat_participants
    FOR SELECT USING (
        user_id = auth.uid() OR
        is_conversation_participant(conversation_id, auth.uid())
    );

CREATE POLICY "chat_participants_insert" ON public.chat_participants
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.chat_conversations
            WHERE id = conversation_id AND created_by = auth.uid()
        )
        OR
        user_id = auth.uid()
    );

CREATE POLICY "chat_participants_update" ON public.chat_participants
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "chat_participants_delete" ON public.chat_participants
    FOR DELETE USING (
        user_id = auth.uid() OR
        EXISTS (
            SELECT 1 FROM public.chat_conversations
            WHERE id = conversation_id AND created_by = auth.uid()
        )
    );

-- =====================================================================================
-- STEP 5: CHAT_MESSAGES POLICIES
-- =====================================================================================

CREATE POLICY "chat_messages_select" ON public.chat_messages
    FOR SELECT USING (
        sender_id = auth.uid() OR
        is_conversation_participant(conversation_id, auth.uid())
    );

CREATE POLICY "chat_messages_insert" ON public.chat_messages
    FOR INSERT WITH CHECK (
        sender_id = auth.uid() AND
        is_conversation_participant(conversation_id, auth.uid())
    );

CREATE POLICY "chat_messages_update" ON public.chat_messages
    FOR UPDATE USING (sender_id = auth.uid())
    WITH CHECK (sender_id = auth.uid());

CREATE POLICY "chat_messages_delete" ON public.chat_messages
    FOR DELETE USING (sender_id = auth.uid());

-- =====================================================================================
-- STEP 6: MESSAGE_STATUS POLICIES
-- =====================================================================================

CREATE POLICY "message_status_select" ON public.message_status
    FOR SELECT USING (
        user_id = auth.uid() OR
        EXISTS (
            SELECT 1 FROM public.chat_messages cm
            WHERE cm.id = message_id
            AND (cm.sender_id = auth.uid() OR is_conversation_participant(cm.conversation_id, auth.uid()))
        )
    );

CREATE POLICY "message_status_insert" ON public.message_status
    FOR INSERT WITH CHECK (
        user_id = auth.uid() AND
        EXISTS (
            SELECT 1 FROM public.chat_messages cm
            WHERE cm.id = message_id
            AND is_conversation_participant(cm.conversation_id, auth.uid())
        )
    );

CREATE POLICY "message_status_update" ON public.message_status
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- =====================================================================================
-- STEP 7: GRANT PERMISSIONS
-- =====================================================================================

GRANT EXECUTE ON FUNCTION is_conversation_participant(UUID, UUID) TO PUBLIC;

COMMIT;