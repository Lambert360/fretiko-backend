-- Migration: Fix infinite recursion in chat RLS policies
-- Run this in Supabase SQL Editor

BEGIN;

-- Drop the problematic RLS policies that cause infinite recursion
DROP POLICY IF EXISTS "Users can view participants in their conversations" ON public.chat_participants;
DROP POLICY IF EXISTS "Users can view messages in their conversations" ON public.chat_messages;
DROP POLICY IF EXISTS "Users can send messages to their conversations" ON public.chat_messages;

-- Create corrected RLS policies for chat_participants
-- Allow users to see participants in conversations they are part of
CREATE POLICY "Users can view participants in their conversations" ON public.chat_participants
    FOR SELECT USING (
        -- User can see participants if they are also a participant in that conversation
        user_id = auth.uid() OR
        EXISTS (
            SELECT 1 FROM public.chat_participants cp
            WHERE cp.conversation_id = chat_participants.conversation_id
            AND cp.user_id = auth.uid()
        )
    );

-- Create corrected RLS policies for chat_messages
-- Allow users to view messages in conversations they participate in
CREATE POLICY "Users can view messages in their conversations" ON public.chat_messages
    FOR SELECT USING (
        -- User can see messages if they are a participant in the conversation
        EXISTS (
            SELECT 1 FROM public.chat_participants cp
            WHERE cp.conversation_id = chat_messages.conversation_id
            AND cp.user_id = auth.uid()
        )
    );

-- Allow users to send messages to conversations they participate in
CREATE POLICY "Users can send messages to their conversations" ON public.chat_messages
    FOR INSERT WITH CHECK (
        sender_id = auth.uid() AND
        EXISTS (
            SELECT 1 FROM public.chat_participants cp
            WHERE cp.conversation_id = chat_messages.conversation_id
            AND cp.user_id = auth.uid()
        )
    );

-- Special policy for AI conversations - allow creating AI conversations without participants
CREATE POLICY "Users can create AI conversations" ON public.chat_conversations
    FOR INSERT WITH CHECK (
        created_by = auth.uid() AND
        (chat_type != 'ai' OR chat_type = 'ai')  -- Allow AI conversations
    );

-- Allow AI conversation participants to be created
CREATE POLICY "AI conversations can have system participants" ON public.chat_participants
    FOR INSERT WITH CHECK (
        user_id = auth.uid() OR
        EXISTS (
            SELECT 1 FROM public.chat_conversations cc
            WHERE cc.id = chat_participants.conversation_id
            AND cc.chat_type = 'ai'
            AND cc.created_by = auth.uid()
        )
    );

COMMIT;