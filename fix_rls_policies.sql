-- Fix RLS policies for service role access
-- Replace the problematic current_setting checks with auth.role()

-- Drop old policies
DROP POLICY IF EXISTS "Service role can manage all activity logs" ON user_activity_log;
DROP POLICY IF EXISTS "Service role can manage all refresh tokens" ON refresh_tokens;

-- Create new policies using auth.role()
CREATE POLICY "Service role can manage all activity logs" ON user_activity_log
  FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role can manage all refresh tokens" ON refresh_tokens
  FOR ALL USING (auth.role() = 'service_role');

-- Test the policies
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual
FROM pg_policies 
WHERE tablename IN ('user_activity_log', 'refresh_tokens');
