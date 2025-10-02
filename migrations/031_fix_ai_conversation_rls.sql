-- Migration: Fix AI conversation RLS policies specifically
-- Run this in Supabase SQL Editor

BEGIN;

-- Drop existing problematic policies for chat_participants
DROP POLICY IF EXISTS "AI conversations can have system participants" ON public.chat_participants;
DROP POLICY IF EXISTS "Users can view participants in their conversations" ON public.chat_participants;

-- Create a simplified policy for chat_participants that avoids recursion
-- Allow users to see participants in conversations they are directly part of (without subquery)
CREATE POLICY "Users can view their own participation" ON public.chat_participants
    FOR SELECT USING (user_id = auth.uid());

-- Allow users to see other participants in conversations they are part of
-- This uses a different approach to avoid recursion
CREATE POLICY "Users can view other participants" ON public.chat_participants
    FOR SELECT USING (
        conversation_id IN (
            SELECT cp.conversation_id
            FROM public.chat_participants cp
            WHERE cp.user_id = auth.uid()
        )
    );

-- Allow users to insert themselves as participants
CREATE POLICY "Users can add themselves as participants" ON public.chat_participants
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- Special policy for AI conversations - allow the creator to add the AI participant
CREATE POLICY "AI conversation creators can add AI participants" ON public.chat_participants
    FOR INSERT WITH CHECK (
        conversation_id IN (
            SELECT cc.id
            FROM public.chat_conversations cc
            WHERE cc.chat_type = 'ai'
            AND cc.created_by = auth.uid()
        )
    );

COMMIT;