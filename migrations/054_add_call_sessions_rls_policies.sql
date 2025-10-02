-- Add missing RLS policies for chat_call_sessions table
-- This fixes the "Call session not found" error when joining calls

BEGIN;

-- =====================================================================================
-- CHAT_CALL_SESSIONS RLS POLICIES
-- =====================================================================================

-- Drop existing policies if any (in case of re-running migration)
DROP POLICY IF EXISTS "safe_view_call_sessions" ON public.chat_call_sessions;
DROP POLICY IF EXISTS "safe_create_call_sessions" ON public.chat_call_sessions;
DROP POLICY IF EXISTS "safe_update_call_sessions" ON public.chat_call_sessions;

-- SELECT: Users can view calls in conversations they participate in
CREATE POLICY "safe_view_call_sessions" ON public.chat_call_sessions
    FOR SELECT USING (
        -- Call initiator can see their own calls
        initiator_id = auth.uid() OR
        -- Participants in the conversation can see calls
        conversation_id IN (
            SELECT conversation_id FROM public.chat_participants
            WHERE user_id = auth.uid()
        ) OR
        -- Users who are call participants can see the call
        id IN (
            SELECT call_session_id FROM public.call_participants
            WHERE user_id = auth.uid()
        )
    );

-- INSERT: Users can create calls in conversations they participate in
CREATE POLICY "safe_create_call_sessions" ON public.chat_call_sessions
    FOR INSERT WITH CHECK (
        -- User must be the initiator
        initiator_id = auth.uid() AND
        -- User must be a participant in the conversation
        conversation_id IN (
            SELECT conversation_id FROM public.chat_participants
            WHERE user_id = auth.uid()
        )
    );

-- UPDATE: Call initiators and participants can update call status
CREATE POLICY "safe_update_call_sessions" ON public.chat_call_sessions
    FOR UPDATE USING (
        -- Call initiator can update
        initiator_id = auth.uid() OR
        -- Call participants can update
        id IN (
            SELECT call_session_id FROM public.call_participants
            WHERE user_id = auth.uid()
        )
    ) WITH CHECK (
        -- Ensure user is still initiator or participant
        initiator_id = auth.uid() OR
        id IN (
            SELECT call_session_id FROM public.call_participants
            WHERE user_id = auth.uid()
        )
    );

-- Add comment for documentation
COMMENT ON TABLE public.chat_call_sessions IS 'Table for tracking call sessions with RLS policies added in migration 054';

COMMIT;
