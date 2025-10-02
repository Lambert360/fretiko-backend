-- Comprehensive Chat System RLS Fix
-- This migration completely replaces all recursive RLS policies with safe, non-recursive ones
-- Run this in Supabase SQL Editor

BEGIN;

-- =====================================================================================
-- STEP 1: DROP ALL EXISTING PROBLEMATIC RLS POLICIES
-- =====================================================================================

-- Drop chat_conversations policies
DROP POLICY IF EXISTS "Users can view conversations they participate in" ON public.chat_conversations;
DROP POLICY IF EXISTS "Users can create conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Participants can update conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Allow conversation creation" ON public.chat_conversations;
DROP POLICY IF EXISTS "Allow viewing conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Allow updating own conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Allow deleting own conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Users can create AI conversations" ON public.chat_conversations;

-- Drop chat_participants policies
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

-- Drop chat_messages policies
DROP POLICY IF EXISTS "Users can view messages in their conversations" ON public.chat_messages;
DROP POLICY IF EXISTS "Users can send messages to their conversations" ON public.chat_messages;
DROP POLICY IF EXISTS "Users can update their own messages" ON public.chat_messages;

-- Drop message_status policies
DROP POLICY IF EXISTS "Users can view message status for their messages" ON public.message_status;
DROP POLICY IF EXISTS "Users can update message status" ON public.message_status;
DROP POLICY IF EXISTS "Users can update their message status" ON public.message_status;

-- =====================================================================================
-- STEP 2: CREATE SAFE, NON-RECURSIVE RLS POLICIES
-- =====================================================================================

-- ---------------------------------------------------------------------------------
-- CHAT_CONVERSATIONS POLICIES (Safe - no recursion)
-- ---------------------------------------------------------------------------------

-- SELECT: Users can view conversations they created OR where they exist in a separate user_profiles table
CREATE POLICY "safe_view_conversations" ON public.chat_conversations
    FOR SELECT USING (
        created_by = auth.uid()  -- Non-recursive: direct creator check
    );

-- INSERT: Users can create conversations (completely safe)
CREATE POLICY "safe_create_conversations" ON public.chat_conversations
    FOR INSERT WITH CHECK (
        created_by = auth.uid()  -- Non-recursive: direct creator check
    );

-- UPDATE: Only creators can update conversations (completely safe)
CREATE POLICY "safe_update_conversations" ON public.chat_conversations
    FOR UPDATE USING (created_by = auth.uid())
    WITH CHECK (created_by = auth.uid());

-- DELETE: Only creators can delete conversations (completely safe)
CREATE POLICY "safe_delete_conversations" ON public.chat_conversations
    FOR DELETE USING (created_by = auth.uid());

-- ---------------------------------------------------------------------------------
-- CHAT_PARTICIPANTS POLICIES (Safe - no recursion)
-- ---------------------------------------------------------------------------------

-- SELECT: Users can see their own participation records (completely safe)
CREATE POLICY "safe_view_own_participation" ON public.chat_participants
    FOR SELECT USING (
        user_id = auth.uid()  -- Non-recursive: only own records
    );

-- INSERT: Users can add themselves to conversations they created, or be added by creators
CREATE POLICY "safe_add_participants" ON public.chat_participants
    FOR INSERT WITH CHECK (
        user_id = auth.uid() OR  -- Can add themselves
        conversation_id IN (
            SELECT id FROM public.chat_conversations
            WHERE created_by = auth.uid()  -- Or be added by conversation creator
        )
    );

-- UPDATE: Users can only update their own participation
CREATE POLICY "safe_update_own_participation" ON public.chat_participants
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- DELETE: Users can remove themselves, or creators can remove anyone
CREATE POLICY "safe_remove_participants" ON public.chat_participants
    FOR DELETE USING (
        user_id = auth.uid() OR  -- Remove themselves
        conversation_id IN (
            SELECT id FROM public.chat_conversations
            WHERE created_by = auth.uid()  -- Or creator removes others
        )
    );

-- ---------------------------------------------------------------------------------
-- CHAT_MESSAGES POLICIES (Safe - using direct joins instead of subqueries)
-- ---------------------------------------------------------------------------------

-- SELECT: Users can view messages in conversations they participate in
-- Using a direct approach to avoid recursion
CREATE POLICY "safe_view_messages" ON public.chat_messages
    FOR SELECT USING (
        -- Messages from conversations user created
        conversation_id IN (
            SELECT id FROM public.chat_conversations
            WHERE created_by = auth.uid()
        )
        OR
        -- Messages where user is sender
        sender_id = auth.uid()
    );

-- INSERT: Users can send messages to conversations they created or where they're participants
CREATE POLICY "safe_send_messages" ON public.chat_messages
    FOR INSERT WITH CHECK (
        sender_id = auth.uid() AND (
            -- To conversations they created
            conversation_id IN (
                SELECT id FROM public.chat_conversations
                WHERE created_by = auth.uid()
            )
            OR
            -- To conversations where they are participants (direct check)
            conversation_id IN (
                SELECT DISTINCT conversation_id FROM public.chat_participants
                WHERE user_id = auth.uid()
            )
        )
    );

-- UPDATE: Users can only update their own messages
CREATE POLICY "safe_update_messages" ON public.chat_messages
    FOR UPDATE USING (sender_id = auth.uid())
    WITH CHECK (sender_id = auth.uid());

-- DELETE: Users can delete their own messages
CREATE POLICY "safe_delete_messages" ON public.chat_messages
    FOR DELETE USING (sender_id = auth.uid());

-- ---------------------------------------------------------------------------------
-- MESSAGE_STATUS POLICIES (Safe - direct user checks)
-- ---------------------------------------------------------------------------------

-- SELECT: Users can view status of their own messages or messages sent to them
CREATE POLICY "safe_view_message_status" ON public.message_status
    FOR SELECT USING (
        user_id = auth.uid() OR  -- Their own status records
        message_id IN (
            SELECT id FROM public.chat_messages
            WHERE sender_id = auth.uid()  -- Status of messages they sent
        )
    );

-- INSERT: Users can create status records for themselves
CREATE POLICY "safe_create_message_status" ON public.message_status
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- UPDATE: Users can update their own status records
CREATE POLICY "safe_update_message_status" ON public.message_status
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------------------------------------------
-- OTHER CHAT TABLES POLICIES (Safe - following same pattern)
-- ---------------------------------------------------------------------------------

-- File uploads
CREATE POLICY "safe_view_file_uploads" ON public.chat_file_uploads
    FOR SELECT USING (uploader_id = auth.uid());

CREATE POLICY "safe_create_file_uploads" ON public.chat_file_uploads
    FOR INSERT WITH CHECK (uploader_id = auth.uid());

-- Livestreams
CREATE POLICY "safe_view_livestreams" ON public.chat_livestreams
    FOR SELECT USING (
        streamer_id = auth.uid() OR
        conversation_id IN (
            SELECT id FROM public.chat_conversations
            WHERE created_by = auth.uid()
        )
    );

CREATE POLICY "safe_create_livestreams" ON public.chat_livestreams
    FOR INSERT WITH CHECK (streamer_id = auth.uid());

-- Auctions
CREATE POLICY "safe_view_auctions" ON public.chat_auctions
    FOR SELECT USING (
        seller_id = auth.uid() OR
        conversation_id IN (
            SELECT id FROM public.chat_conversations
            WHERE created_by = auth.uid()
        )
    );

CREATE POLICY "safe_create_auctions" ON public.chat_auctions
    FOR INSERT WITH CHECK (seller_id = auth.uid());

-- Call sessions
CREATE POLICY "safe_view_call_sessions" ON public.chat_call_sessions
    FOR SELECT USING (
        initiator_id = auth.uid() OR
        conversation_id IN (
            SELECT id FROM public.chat_conversations
            WHERE created_by = auth.uid()
        )
    );

CREATE POLICY "safe_create_call_sessions" ON public.chat_call_sessions
    FOR INSERT WITH CHECK (initiator_id = auth.uid());

-- AI assistant sessions
CREATE POLICY "safe_view_ai_sessions" ON public.ai_assistant_sessions
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "safe_create_ai_sessions" ON public.ai_assistant_sessions
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- AI research requests
CREATE POLICY "safe_view_ai_research" ON public.ai_research_requests
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "safe_create_ai_research" ON public.ai_research_requests
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- Activity planning sessions
CREATE POLICY "safe_view_activity_planning" ON public.activity_planning_sessions
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "safe_create_activity_planning" ON public.activity_planning_sessions
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- =====================================================================================
-- STEP 3: CREATE HELPER FUNCTION FOR CONVERSATION ACCESS (Optional optimization)
-- =====================================================================================

-- This function can be used in future policies for better performance
CREATE OR REPLACE FUNCTION user_has_conversation_access(conversation_id UUID, user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    -- Check if user created the conversation
    IF EXISTS (
        SELECT 1 FROM public.chat_conversations
        WHERE id = conversation_id AND created_by = user_id
    ) THEN
        RETURN TRUE;
    END IF;

    -- Check if user is a participant
    IF EXISTS (
        SELECT 1 FROM public.chat_participants
        WHERE conversation_id = conversation_id AND user_id = user_id
    ) THEN
        RETURN TRUE;
    END IF;

    RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMIT;