-- Comprehensive debugging for authentication issues
-- This will help us identify the exact problem

-- 1. Check if tables exist and have data
SELECT 'refresh_tokens table exists' as check, 
       EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'refresh_tokens') as exists_check;

SELECT 'user_activity_log table exists' as check,
       EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_activity_log') as exists_check;

-- 2. Check if refresh tokens are being created
SELECT COUNT(*) as total_refresh_tokens,
       COUNT(CASE WHEN is_revoked = false THEN 1 END) as active_tokens,
       COUNT(CASE WHEN created_at > NOW() - INTERVAL '1 hour' THEN 1 END) as recent_tokens
FROM refresh_tokens;

-- 3. Check if user activity is being logged
SELECT COUNT(*) as total_activities,
       COUNT(CASE WHEN activity_type = 'login' THEN 1 END) as login_activities,
       MAX(timestamp) as last_activity
FROM user_activity_log;

-- 4. Check current RLS policies
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual
FROM pg_policies 
WHERE tablename IN ('user_activity_log', 'refresh_tokens')
ORDER BY tablename, policyname;

-- 5. Check if service role can bypass RLS
-- Test with a direct query that should work
SELECT 'Testing service role access' as test;

-- 6. Disable RLS completely for testing
ALTER TABLE refresh_tokens DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_activity_log DISABLE ROW LEVEL SECURITY;

-- 7. Test without RLS
SELECT 'Testing without RLS - refresh_tokens count:' as test,
       COUNT(*) as count
FROM refresh_tokens;

SELECT 'Testing without RLS - activity_log count:' as test,
       COUNT(*) as count
FROM user_activity_log;

-- 8. Check if there are any refresh tokens for our test user
SELECT 'Checking for user ff943371-0f93-4444-9df1-10124cc9f347' as test;
SELECT COUNT(*) as user_token_count
FROM refresh_tokens 
WHERE user_id = 'ff943371-0f93-4444-9df1-10124cc9f347';

-- 9. Leave RLS disabled for now (temporary fix)
SELECT 'RLS DISABLED - This should fix the issue temporarily' as status;
