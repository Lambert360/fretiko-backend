-- Migration: Add missing foreign key relationships for chat system
-- Run this in Supabase SQL Editor

BEGIN;

-- Add foreign key constraint from chat_participants.user_id to user_profiles.id
-- First, let's make sure chat_participants references user_profiles instead of auth.users
ALTER TABLE public.chat_participants
DROP CONSTRAINT IF EXISTS chat_participants_user_id_fkey;

-- Add the correct foreign key to user_profiles
ALTER TABLE public.chat_participants
ADD CONSTRAINT chat_participants_user_id_fkey
FOREIGN KEY (user_id) REFERENCES public.user_profiles(id) ON DELETE CASCADE;

-- Also ensure chat_messages references user_profiles for sender_id
ALTER TABLE public.chat_messages
DROP CONSTRAINT IF EXISTS chat_messages_sender_id_fkey;

ALTER TABLE public.chat_messages
ADD CONSTRAINT chat_messages_sender_id_fkey
FOREIGN KEY (sender_id) REFERENCES public.user_profiles(id) ON DELETE CASCADE;

-- And for chat_conversations.created_by
ALTER TABLE public.chat_conversations
DROP CONSTRAINT IF EXISTS chat_conversations_created_by_fkey;

ALTER TABLE public.chat_conversations
ADD CONSTRAINT chat_conversations_created_by_fkey
FOREIGN KEY (created_by) REFERENCES public.user_profiles(id) ON DELETE CASCADE;

COMMIT;