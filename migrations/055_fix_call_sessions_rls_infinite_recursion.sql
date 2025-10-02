-- Fix infinite recursion in chat_call_sessions RLS policies
-- The previous policies referenced call_participants which caused circular dependency

BEGIN;

-- Drop the problematic policies
DROP POLICY IF EXISTS "safe_view_call_sessions" ON public.chat_call_sessions;
DROP POLICY IF EXISTS "safe_create_call_sessions" ON public.chat_call_sessions;
DROP POLICY IF EXISTS "safe_update_call_sessions" ON public.chat_call_sessions;

-- SELECT: Users can view calls in conversations they participate in
-- Removed the call_participants check to avoid infinite recursion
CREATE POLICY "safe_view_call_sessions" ON public.chat_call_sessions
    FOR SELECT USING (
        -- Call initiator can see their own calls
        initiator_id = auth.uid() OR
        -- Participants in the conversation can see calls
        conversation_id IN (
            SELECT conversation_id FROM public.chat_participants
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

-- UPDATE: Call initiators and conversation participants can update call status
-- Removed the call_participants check to avoid infinite recursion
CREATE POLICY "safe_update_call_sessions" ON public.chat_call_sessions
    FOR UPDATE USING (
        -- Call initiator can update
        initiator_id = auth.uid() OR
        -- Any participant in the conversation can update call
        conversation_id IN (
            SELECT conversation_id FROM public.chat_participants
            WHERE user_id = auth.uid()
        )
    ) WITH CHECK (
        -- Ensure user is still initiator or conversation participant
        initiator_id = auth.uid() OR
        conversation_id IN (
            SELECT conversation_id FROM public.chat_participants
            WHERE user_id = auth.uid()
        )
    );

-- Add comment for documentation
COMMENT ON TABLE public.chat_call_sessions IS 'Table for tracking call sessions with RLS policies fixed for infinite recursion in migration 055';

COMMIT;
