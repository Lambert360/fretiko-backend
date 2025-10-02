-- Fix RLS policies for call_participants to allow service role access
-- The service role should be able to add participants on behalf of call initiators

BEGIN;

-- Drop existing policies
DROP POLICY IF EXISTS "safe_view_call_participants" ON public.call_participants;
DROP POLICY IF EXISTS "safe_add_call_participants" ON public.call_participants;
DROP POLICY IF EXISTS "safe_update_call_participants" ON public.call_participants;
DROP POLICY IF EXISTS "safe_remove_call_participants" ON public.call_participants;

-- SELECT: Users can view participants of calls they are part of
CREATE POLICY "safe_view_call_participants" ON public.call_participants
    FOR SELECT USING (
        -- Service role can view anything
        auth.uid() IS NULL OR
        user_id = auth.uid() OR  -- Users can see their own participation
        call_session_id IN (
            SELECT id FROM public.chat_call_sessions
            WHERE initiator_id = auth.uid()  -- Call initiators can see all participants
        ) OR
        call_session_id IN (
            SELECT call_session_id FROM public.call_participants
            WHERE user_id = auth.uid()  -- Users can see other participants in calls they're part of
        )
    );

-- INSERT: Service role, call initiators, or users themselves can add participants
CREATE POLICY "safe_add_call_participants" ON public.call_participants
    FOR INSERT WITH CHECK (
        -- Service role can add any participants
        auth.uid() IS NULL OR
        user_id = auth.uid() OR  -- Users can add themselves
        call_session_id IN (
            SELECT id FROM public.chat_call_sessions
            WHERE initiator_id = auth.uid()  -- Call initiators can add any participants
        )
    );

-- UPDATE: Service role or users can update their own call participation settings
CREATE POLICY "safe_update_call_participants" ON public.call_participants
    FOR UPDATE USING (
        -- Service role can update anything
        auth.uid() IS NULL OR
        user_id = auth.uid()
    )
    WITH CHECK (
        -- Service role can update anything
        auth.uid() IS NULL OR
        user_id = auth.uid()
    );

-- DELETE: Service role, users themselves, or call initiators can remove participants
CREATE POLICY "safe_remove_call_participants" ON public.call_participants
    FOR DELETE USING (
        -- Service role can delete anything
        auth.uid() IS NULL OR
        user_id = auth.uid() OR  -- Users can remove themselves
        call_session_id IN (
            SELECT id FROM public.chat_call_sessions
            WHERE initiator_id = auth.uid()  -- Call initiators can remove any participants
        )
    );

-- Add comment for documentation
COMMENT ON TABLE public.call_participants IS 'Table for tracking participants in call sessions with service role bypass added in migration 057';

COMMIT;
