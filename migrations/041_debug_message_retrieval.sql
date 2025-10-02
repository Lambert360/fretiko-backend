-- Debug Message Retrieval Issues
-- Run this in Supabase SQL Editor to check what's happening

-- 1. Check how many messages exist in total
SELECT
    count(*) as total_messages,
    count(CASE WHEN created_at > NOW() - INTERVAL '1 hour' THEN 1 END) as recent_messages
FROM public.chat_messages;

-- 2. Check messages by conversation
SELECT
    conversation_id,
    count(*) as message_count,
    MIN(created_at) as first_message,
    MAX(created_at) as last_message
FROM public.chat_messages
GROUP BY conversation_id
ORDER BY last_message DESC;

-- 3. Check if RLS is blocking messages (run as authenticated user)
-- Replace 'your-user-id' with an actual user ID from your database
-- SELECT
--     id, content, sender_id, conversation_id, created_at
-- FROM public.chat_messages
-- WHERE conversation_id = 'your-conversation-id'
-- ORDER BY created_at DESC;

-- 4. Check current RLS policies
SELECT
    schemaname, tablename, policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
AND tablename = 'chat_messages'
ORDER BY policyname;

-- 5. Test the is_conversation_participant function
-- SELECT is_conversation_participant('your-conversation-id', 'your-user-id');

-- 6. Check participant records
SELECT
    cp.conversation_id,
    cp.user_id,
    cp.created_at as participant_added,
    cc.chat_type,
    cc.created_by
FROM public.chat_participants cp
JOIN public.chat_conversations cc ON cp.conversation_id = cc.id
ORDER BY cp.created_at DESC
LIMIT 10;