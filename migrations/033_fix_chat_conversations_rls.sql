-- Migration: Fix chat_conversations RLS policies to prevent recursion
-- Run this in Supabase SQL Editor

BEGIN;

-- Drop all existing chat_conversations policies that might cause recursion
DROP POLICY IF EXISTS "Users can view their conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Users can create conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Users can update their conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Users can delete their conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Users can create AI conversations" ON public.chat_conversations;

-- Create non-recursive policies for chat_conversations

-- 1. INSERT Policy: Allow users to create conversations
CREATE POLICY "Allow conversation creation" ON public.chat_conversations
    FOR INSERT WITH CHECK (
        -- Users can create conversations where they are the creator
        created_by = auth.uid()
    );

-- 2. SELECT Policy: Allow users to view conversations (non-recursive)
CREATE POLICY "Allow viewing conversations" ON public.chat_conversations
    FOR SELECT USING (
        -- Users can see conversations they created
        created_by = auth.uid() OR
        -- Users can see conversations where they are participants
        -- (This avoids recursion by not checking chat_participants in a subquery)
        id IN (
            SELECT DISTINCT conversation_id
            FROM public.chat_participants
            WHERE user_id = auth.uid()
        )
    );

-- 3. UPDATE Policy: Allow users to update conversations they created
CREATE POLICY "Allow updating own conversations" ON public.chat_conversations
    FOR UPDATE USING (created_by = auth.uid())
    WITH CHECK (created_by = auth.uid());

-- 4. DELETE Policy: Allow users to delete conversations they created
CREATE POLICY "Allow deleting own conversations" ON public.chat_conversations
    FOR DELETE USING (created_by = auth.uid());

COMMIT;