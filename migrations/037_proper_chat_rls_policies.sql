-- Proper RLS Policies for 1-on-1 and Group Chat Support
-- This enables both individual and group conversations with correct permissions
-- Run this in Supabase SQL Editor

BEGIN;

-- =====================================================================================
-- STEP 1: DROP ALL EXISTING CHAT RLS POLICIES
-- =====================================================================================

-- Drop chat_conversations policies
DROP POLICY IF EXISTS "safe_view_conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "safe_create_conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "safe_update_conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "safe_delete_conversations" ON public.chat_conversations;

-- Drop chat_participants policies
DROP POLICY IF EXISTS "safe_view_own_participation" ON public.chat_participants;
DROP POLICY IF EXISTS "safe_add_participants" ON public.chat_participants;
DROP POLICY IF EXISTS "safe_update_own_participation" ON public.chat_participants;
DROP POLICY IF EXISTS "safe_remove_participants" ON public.chat_participants;

-- Drop chat_messages policies
DROP POLICY IF EXISTS "safe_view_messages" ON public.chat_messages;
DROP POLICY IF EXISTS "safe_send_messages" ON public.chat_messages;
DROP POLICY IF EXISTS "safe_update_messages" ON public.chat_messages;
DROP POLICY IF EXISTS "safe_delete_messages" ON public.chat_messages;
DROP POLICY IF EXISTS "simple_send_messages" ON public.chat_messages;
DROP POLICY IF EXISTS "simple_view_messages" ON public.chat_messages;

-- Drop message_status policies
DROP POLICY IF EXISTS "safe_view_message_status" ON public.message_status;
DROP POLICY IF EXISTS "safe_create_message_status" ON public.message_status;
DROP POLICY IF EXISTS "safe_update_message_status" ON public.message_status;

-- =====================================================================================
-- STEP 2: CREATE FUNCTION TO CHECK IF USER IS PARTICIPANT
-- =====================================================================================

-- This function safely checks if a user is a participant without recursion
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

-- SELECT: Users can view conversations they participate in
CREATE POLICY "chat_conversations_select" ON public.chat_conversations
    FOR SELECT USING (
        created_by = auth.uid() OR
        is_conversation_participant(id, auth.uid())
    );

-- INSERT: Users can create conversations
CREATE POLICY "chat_conversations_insert" ON public.chat_conversations
    FOR INSERT WITH CHECK (created_by = auth.uid());

-- UPDATE: Only creators can update conversation settings
CREATE POLICY "chat_conversations_update" ON public.chat_conversations
    FOR UPDATE USING (created_by = auth.uid())
    WITH CHECK (created_by = auth.uid());

-- DELETE: Only creators can delete conversations
CREATE POLICY "chat_conversations_delete" ON public.chat_conversations
    FOR DELETE USING (created_by = auth.uid());

-- =====================================================================================
-- STEP 4: CHAT_PARTICIPANTS POLICIES
-- =====================================================================================

-- SELECT: Users can see participants in conversations they participate in
CREATE POLICY "chat_participants_select" ON public.chat_participants
    FOR SELECT USING (
        user_id = auth.uid() OR
        is_conversation_participant(conversation_id, auth.uid())
    );

-- INSERT: Conversation creators can add participants, users can join open conversations
CREATE POLICY "chat_participants_insert" ON public.chat_participants
    FOR INSERT WITH CHECK (
        -- Conversation creators can add anyone
        EXISTS (
            SELECT 1 FROM public.chat_conversations
            WHERE id = conversation_id AND created_by = auth.uid()
        )
        OR
        -- Users can add themselves (for joining)
        user_id = auth.uid()
    );

-- UPDATE: Users can update their own participation settings
CREATE POLICY "chat_participants_update" ON public.chat_participants
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- DELETE: Users can leave (remove themselves) or creators can remove others
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

-- SELECT: Users can view messages in conversations they participate in
CREATE POLICY "chat_messages_select" ON public.chat_messages
    FOR SELECT USING (
        sender_id = auth.uid() OR
        is_conversation_participant(conversation_id, auth.uid())
    );

-- INSERT: Participants can send messages to conversations they're in
CREATE POLICY "chat_messages_insert" ON public.chat_messages
    FOR INSERT WITH CHECK (
        sender_id = auth.uid() AND
        is_conversation_participant(conversation_id, auth.uid())
    );

-- UPDATE: Users can only edit their own messages
CREATE POLICY "chat_messages_update" ON public.chat_messages
    FOR UPDATE USING (sender_id = auth.uid())
    WITH CHECK (sender_id = auth.uid());

-- DELETE: Users can delete their own messages
CREATE POLICY "chat_messages_delete" ON public.chat_messages
    FOR DELETE USING (sender_id = auth.uid());

-- =====================================================================================
-- STEP 6: MESSAGE_STATUS POLICIES
-- =====================================================================================

-- SELECT: Users can view status of messages in conversations they participate in
CREATE POLICY "message_status_select" ON public.message_status
    FOR SELECT USING (
        user_id = auth.uid() OR
        EXISTS (
            SELECT 1 FROM public.chat_messages cm
            WHERE cm.id = message_id
            AND (cm.sender_id = auth.uid() OR is_conversation_participant(cm.conversation_id, auth.uid()))
        )
    );

-- INSERT: Users can create status for messages in conversations they participate in
CREATE POLICY "message_status_insert" ON public.message_status
    FOR INSERT WITH CHECK (
        user_id = auth.uid() AND
        EXISTS (
            SELECT 1 FROM public.chat_messages cm
            WHERE cm.id = message_id
            AND is_conversation_participant(cm.conversation_id, auth.uid())
        )
    );

-- UPDATE: Users can update their own message status
CREATE POLICY "message_status_update" ON public.message_status
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- =====================================================================================
-- STEP 7: GRANT EXECUTE ON FUNCTION
-- =====================================================================================

-- Grant execute permission on our helper function
GRANT EXECUTE ON FUNCTION is_conversation_participant(UUID, UUID) TO PUBLIC;

COMMIT;