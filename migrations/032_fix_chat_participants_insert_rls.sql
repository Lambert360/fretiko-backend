-- Migration: Fix chat_participants RLS policies to handle INSERT operations properly
-- Run this in Supabase SQL Editor

BEGIN;

-- Drop all existing chat_participants policies that cause recursion
DROP POLICY IF EXISTS "Users can view participants in their conversations" ON public.chat_participants;
DROP POLICY IF EXISTS "Users can view their own participation" ON public.chat_participants;
DROP POLICY IF EXISTS "Users can view other participants" ON public.chat_participants;
DROP POLICY IF EXISTS "Users can add themselves as participants" ON public.chat_participants;
DROP POLICY IF EXISTS "AI conversation creators can add AI participants" ON public.chat_participants;
DROP POLICY IF EXISTS "AI conversations can have system participants" ON public.chat_participants;

-- Create separate policies for different operations to avoid recursion

-- 1. INSERT Policy: Allow users to create participant records
CREATE POLICY "Allow participant creation" ON public.chat_participants
    FOR INSERT WITH CHECK (
        -- Users can always add themselves to any conversation
        user_id = auth.uid() OR
        -- Conversation creators can add anyone to their conversations
        EXISTS (
            SELECT 1 FROM public.chat_conversations cc
            WHERE cc.id = chat_participants.conversation_id
            AND cc.created_by = auth.uid()
        )
    );

-- 2. SELECT Policy: Allow users to view participants (non-recursive)
CREATE POLICY "Allow viewing participants" ON public.chat_participants
    FOR SELECT USING (
        -- Users can see their own participation records
        user_id = auth.uid() OR
        -- Users can see participants in conversations they created
        EXISTS (
            SELECT 1 FROM public.chat_conversations cc
            WHERE cc.id = chat_participants.conversation_id
            AND cc.created_by = auth.uid()
        )
    );

-- 3. UPDATE Policy: Allow users to update their own participation
CREATE POLICY "Allow updating own participation" ON public.chat_participants
    FOR UPDATE USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- 4. DELETE Policy: Allow users to remove themselves or creators to remove others
CREATE POLICY "Allow removing participants" ON public.chat_participants
    FOR DELETE USING (
        -- Users can remove themselves
        user_id = auth.uid() OR
        -- Conversation creators can remove anyone
        EXISTS (
            SELECT 1 FROM public.chat_conversations cc
            WHERE cc.id = chat_participants.conversation_id
            AND cc.created_by = auth.uid()
        )
    );

COMMIT;