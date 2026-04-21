-- SURGICAL RLS FIX - Only fix the broken tables
-- Leave all correctly-configured tables untouched
-- This aligns refresh_tokens and user_activity_log with your existing Supabase auth patterns

-- Step 1: Remove problematic policies ONLY from token tables
DROP POLICY IF EXISTS "Users can manage their own refresh tokens" ON refresh_tokens;
DROP POLICY IF EXISTS "Users can manage their own activity logs" ON user_activity_log;
DROP POLICY IF EXISTS "Service role all access" ON refresh_tokens;
DROP POLICY IF EXISTS "Service role all access" ON user_activity_log;
DROP POLICY IF EXISTS "Service role access" ON refresh_tokens;
DROP POLICY IF EXISTS "Service role access" ON user_activity_log;

-- Step 2: Create CORRECT policies using standard Supabase auth
-- Match the pattern used by all your other tables (escrow, disputes, staff, etc.)

-- Refresh tokens (now consistent with escrow/dispute/staff systems)
CREATE POLICY "Users manage own tokens"
ON refresh_tokens
FOR ALL
USING (auth.uid() = user_id);

CREATE POLICY "Service role full access"
ON refresh_tokens
FOR ALL
USING (auth.role() = 'service_role');

-- Activity log (now consistent with all other systems)
CREATE POLICY "Users manage own activity"
ON user_activity_log
FOR ALL
USING (auth.uid() = user_id);

CREATE POLICY "Service role full access"
ON user_activity_log
FOR ALL
USING (auth.role() = 'service_role');

-- Step 3: Verify the fix
SELECT 'Surgical RLS fix completed' as status;

-- Show fixed tables
SELECT 
  tablename,
  policyname,
  permissive,
  cmd,
  qual
FROM pg_policies 
WHERE tablename IN ('refresh_tokens', 'user_activity_log')
ORDER BY tablename, policyname;

-- Confirm other tables are untouched
SELECT COUNT(*) as other_tables_untouched
FROM pg_policies 
WHERE tablename NOT IN ('refresh_tokens', 'user_activity_log');

SELECT 'Token system fixed, all other systems preserved!' as result;
