-- Simple RLS fix - disable RLS temporarily for testing
-- This will help us debug if RLS is the issue

-- Disable RLS completely (temporary)
ALTER TABLE refresh_tokens DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_activity_log DISABLE ROW LEVEL SECURITY;

-- Test queries
SELECT 'Testing refresh_tokens access' as test;
SELECT COUNT(*) as refresh_token_count FROM refresh_tokens;

SELECT 'Testing user_activity_log access' as test;
SELECT COUNT(*) as activity_log_count FROM user_activity_log;

-- Re-enable with simpler policies
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_activity_log ENABLE ROW LEVEL SECURITY;

-- Drop all existing policies
DROP POLICY IF EXISTS "Users can view their own refresh tokens" ON refresh_tokens;
DROP POLICY IF EXISTS "Users can insert their own refresh tokens" ON refresh_tokens;
DROP POLICY IF EXISTS "Users can update their own refresh tokens" ON refresh_tokens;
DROP POLICY IF EXISTS "Users can delete their own refresh tokens" ON refresh_tokens;
DROP POLICY IF EXISTS "Service role can manage all refresh tokens" ON refresh_tokens;

DROP POLICY IF EXISTS "Users can view their own activity logs" ON user_activity_log;
DROP POLICY IF EXISTS "Users can insert their own activity logs" ON user_activity_log;
DROP POLICY IF EXISTS "Service role can manage all activity logs" ON user_activity_log;

-- Create simple bypass policies
CREATE POLICY "Enable all access for service role" ON refresh_tokens
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

CREATE POLICY "Enable all access for service role" ON user_activity_log
  FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- Test the policies
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  cmd,
  roles
FROM pg_policies 
WHERE tablename IN ('user_activity_log', 'refresh_tokens');
