-- REMOVE SERVICE ROLE POLICIES - They do nothing and may cause conflicts
-- Service role bypasses RLS by design, so these policies are unnecessary

-- Drop service role policies from refresh_tokens
DROP POLICY IF EXISTS "Service role full access" ON refresh_tokens;

-- Drop service role policies from user_activity_log
DROP POLICY IF EXISTS "Service role full access" ON user_activity_log;

-- Verify removal
SELECT 'Service role policies removed' as status;

-- Show remaining policies
SELECT 
  tablename,
  policyname,
  permissive,
  cmd,
  qual
FROM pg_policies 
WHERE tablename IN ('refresh_tokens', 'user_activity_log')
ORDER BY tablename, policyname;

SELECT 'Service role policy cleanup completed!' as result;
