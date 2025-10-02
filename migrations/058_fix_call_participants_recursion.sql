-- Fix infinite recursion in call_participants RLS policies
-- The issue: SELECT policy references chat_call_sessions which references call_participants
-- Solution: Simplify policies to avoid circular dependency

BEGIN;

-- Drop problematic policies
DROP POLICY IF EXISTS "safe_view_call_participants" ON public.call_participants;
DROP POLICY IF EXISTS "safe_add_call_participants" ON public.call_participants;
DROP POLICY IF EXISTS "safe_update_call_participants" ON public.call_participants;
DROP POLICY IF EXISTS "safe_remove_call_participants" ON public.call_participants;

-- SELECT: Users can view their own participation OR service role can view all
-- REMOVED: chat_call_sessions check to avoid infinite recursion
CREATE POLICY "safe_view_call_participants" ON public.call_participants
    FOR SELECT USING (
        -- Service role can view anything
        auth.uid() IS NULL OR
        -- Users can see their own participation
        user_id = auth.uid()
    );

-- INSERT: Service role or users adding themselves
-- REMOVED: chat_call_sessions check to avoid infinite recursion
CREATE POLICY "safe_add_call_participants" ON public.call_participants
    FOR INSERT WITH CHECK (
        -- Service role can add any participants
        auth.uid() IS NULL OR
        -- Users can add themselves
        user_id = auth.uid()
    );

-- UPDATE: Service role or users can update their own settings
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

-- DELETE: Service role or users can remove themselves
-- REMOVED: chat_call_sessions check to avoid infinite recursion
CREATE POLICY "safe_remove_call_participants" ON public.call_participants
    FOR DELETE USING (
        -- Service role can delete anything
        auth.uid() IS NULL OR
        -- Users can remove themselves
        user_id = auth.uid()
    );

-- Add comment for documentation
COMMENT ON TABLE public.call_participants IS 'Table for tracking participants in call sessions with simplified RLS to avoid infinite recursion (migration 058)';

COMMIT;
