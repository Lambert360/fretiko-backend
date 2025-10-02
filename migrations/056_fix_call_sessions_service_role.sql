-- Fix RLS policies for chat_call_sessions to allow service role access
-- The service role should be able to create call sessions on behalf of users

BEGIN;

-- Drop existing INSERT policy
DROP POLICY IF EXISTS "safe_create_call_sessions" ON public.chat_call_sessions;

-- Recreate INSERT policy with service role bypass
-- Service role can insert any call session (auth.uid() IS NULL for service role)
-- Regular users must be initiator and conversation participant
CREATE POLICY "safe_create_call_sessions" ON public.chat_call_sessions
    FOR INSERT WITH CHECK (
        -- Service role can insert anything (bypass check)
        auth.uid() IS NULL OR
        (
            -- Regular users: must be the initiator
            initiator_id = auth.uid() AND
            -- Regular users: must be a participant in the conversation
            conversation_id IN (
                SELECT conversation_id FROM public.chat_participants
                WHERE user_id = auth.uid()
            )
        )
    );

-- Also update UPDATE policy to allow service role
DROP POLICY IF EXISTS "safe_update_call_sessions" ON public.chat_call_sessions;

CREATE POLICY "safe_update_call_sessions" ON public.chat_call_sessions
    FOR UPDATE USING (
        -- Service role can update anything
        auth.uid() IS NULL OR
        -- Call initiator can update
        initiator_id = auth.uid() OR
        -- Call participants can update
        id IN (
            SELECT call_session_id FROM public.call_participants
            WHERE user_id = auth.uid()
        )
    ) WITH CHECK (
        -- Service role can update anything
        auth.uid() IS NULL OR
        -- Ensure user is still initiator or participant
        initiator_id = auth.uid() OR
        id IN (
            SELECT call_session_id FROM public.call_participants
            WHERE user_id = auth.uid()
        )
    );

-- Also update SELECT policy to allow service role
DROP POLICY IF EXISTS "safe_view_call_sessions" ON public.chat_call_sessions;

CREATE POLICY "safe_view_call_sessions" ON public.chat_call_sessions
    FOR SELECT USING (
        -- Service role can view anything
        auth.uid() IS NULL OR
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

-- Add comment for documentation
COMMENT ON TABLE public.chat_call_sessions IS 'Table for tracking call sessions with service role bypass added in migration 056';

COMMIT;
