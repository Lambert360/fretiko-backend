-- Add missing RLS policies for call_participants table
-- This fixes the "new row violates row-level security policy" error when starting calls

BEGIN;

-- =====================================================================================
-- CALL_PARTICIPANTS RLS POLICIES
-- =====================================================================================

-- SELECT: Users can view participants of calls they are part of
CREATE POLICY "safe_view_call_participants" ON public.call_participants
    FOR SELECT USING (
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

-- INSERT: Call initiators can add participants, users can join calls they're invited to
CREATE POLICY "safe_add_call_participants" ON public.call_participants
    FOR INSERT WITH CHECK (
        user_id = auth.uid() OR  -- Users can add themselves
        call_session_id IN (
            SELECT id FROM public.chat_call_sessions
            WHERE initiator_id = auth.uid()  -- Call initiators can add any participants
        )
    );

-- UPDATE: Users can update their own call participation settings (mute, video, etc.)
CREATE POLICY "safe_update_call_participants" ON public.call_participants
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- DELETE: Users can leave calls, call initiators can remove participants
CREATE POLICY "safe_remove_call_participants" ON public.call_participants
    FOR DELETE USING (
        user_id = auth.uid() OR  -- Users can remove themselves
        call_session_id IN (
            SELECT id FROM public.chat_call_sessions
            WHERE initiator_id = auth.uid()  -- Call initiators can remove any participants
        )
    );

-- Add comment for documentation
COMMENT ON TABLE public.call_participants IS 'Table for tracking participants in call sessions with RLS policies added in migration 048';

COMMIT;