-- Migration: Add Row Level Security (RLS) policies for notifications tables
-- Date: 2025-09-24
-- Description: Secure notifications tables with proper RLS policies to fix 42501 errors

BEGIN;

-- ============================================
-- 1. ENABLE RLS ON NOTIFICATIONS TABLES
-- ============================================

-- Enable RLS on notifications table
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Enable RLS on notification_settings table
ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;

-- Enable RLS on notification_receipts table
ALTER TABLE notification_receipts ENABLE ROW LEVEL SECURITY;

-- ============================================
-- 2. NOTIFICATIONS TABLE RLS POLICIES
-- ============================================

-- Policy 1: Users can view their own notifications
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'notifications' AND policyname = 'Users can view their own notifications'
    ) THEN
        CREATE POLICY "Users can view their own notifications" ON notifications
            FOR SELECT USING (auth.uid() = user_id);
    END IF;
END
$$;

-- Policy 2: System can insert notifications for any user (backend service use)
-- This allows the notification service to create notifications for users
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'notifications' AND policyname = 'System can insert notifications'
    ) THEN
        CREATE POLICY "System can insert notifications" ON notifications
            FOR INSERT WITH CHECK (true);
    END IF;
END
$$;

-- Policy 3: Users can update their own notifications (mark as read, etc.)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'notifications' AND policyname = 'Users can update their own notifications'
    ) THEN
        CREATE POLICY "Users can update their own notifications" ON notifications
            FOR UPDATE USING (auth.uid() = user_id)
            WITH CHECK (auth.uid() = user_id);
    END IF;
END
$$;

-- Policy 4: Users can soft-delete their own notifications
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'notifications' AND policyname = 'Users can delete their own notifications'
    ) THEN
        CREATE POLICY "Users can delete their own notifications" ON notifications
            FOR UPDATE USING (auth.uid() = user_id AND is_deleted = FALSE)
            WITH CHECK (auth.uid() = user_id);
    END IF;
END
$$;

-- ============================================
-- 3. NOTIFICATION_SETTINGS TABLE RLS POLICIES
-- ============================================

-- Policy 1: Users can view their own notification settings
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'notification_settings' AND policyname = 'Users can view their own notification settings'
    ) THEN
        CREATE POLICY "Users can view their own notification settings" ON notification_settings
            FOR SELECT USING (auth.uid() = user_id);
    END IF;
END
$$;

-- Policy 2: Users can insert their own notification settings (on first signup)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'notification_settings' AND policyname = 'Users can insert their own notification settings'
    ) THEN
        CREATE POLICY "Users can insert their own notification settings" ON notification_settings
            FOR INSERT WITH CHECK (auth.uid() = user_id);
    END IF;
END
$$;

-- Policy 3: System can insert default settings for any user (backend service use)
-- This allows the notification service to create default settings for new users
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'notification_settings' AND policyname = 'System can insert default notification settings'
    ) THEN
        CREATE POLICY "System can insert default notification settings" ON notification_settings
            FOR INSERT WITH CHECK (true);
    END IF;
END
$$;

-- Policy 4: Users can update their own notification settings
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'notification_settings' AND policyname = 'Users can update their own notification settings'
    ) THEN
        CREATE POLICY "Users can update their own notification settings" ON notification_settings
            FOR UPDATE USING (auth.uid() = user_id)
            WITH CHECK (auth.uid() = user_id);
    END IF;
END
$$;

-- ============================================
-- 4. NOTIFICATION_RECEIPTS TABLE RLS POLICIES
-- ============================================

-- Policy 1: Users can view their own notification receipts
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'notification_receipts' AND policyname = 'Users can view their own notification receipts'
    ) THEN
        CREATE POLICY "Users can view their own notification receipts" ON notification_receipts
            FOR SELECT USING (auth.uid() = user_id);
    END IF;
END
$$;

-- Policy 2: Users can insert their own notification receipts
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'notification_receipts' AND policyname = 'Users can insert their own notification receipts'
    ) THEN
        CREATE POLICY "Users can insert their own notification receipts" ON notification_receipts
            FOR INSERT WITH CHECK (auth.uid() = user_id);
    END IF;
END
$$;

-- Policy 3: Users can update their own notification receipts
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'notification_receipts' AND policyname = 'Users can update their own notification receipts'
    ) THEN
        CREATE POLICY "Users can update their own notification receipts" ON notification_receipts
            FOR UPDATE USING (auth.uid() = user_id)
            WITH CHECK (auth.uid() = user_id);
    END IF;
END
$$;

-- ============================================
-- 5. GRANT NECESSARY PERMISSIONS
-- ============================================

-- Grant permissions to authenticated users
GRANT SELECT, INSERT, UPDATE ON notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE ON notification_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE ON notification_receipts TO authenticated;

-- Grant access to notification views
GRANT SELECT ON user_notification_stats TO authenticated;
GRANT SELECT ON recent_notifications TO authenticated;
GRANT SELECT ON urgent_notifications TO authenticated;

-- ============================================
-- 6. CREATE DEFAULT SETTINGS FOR EXISTING USERS (RETRY)
-- ============================================
-- This ensures any users created since the initial migration get default settings
INSERT INTO notification_settings (user_id)
SELECT id FROM user_profiles
WHERE id NOT IN (SELECT user_id FROM notification_settings)
ON CONFLICT (user_id) DO NOTHING;

-- ============================================
-- 7. VERIFICATION QUERIES
-- ============================================

-- Check that RLS is enabled on all notification tables
SELECT
  schemaname,
  tablename,
  rowsecurity as rls_enabled
FROM pg_tables
WHERE tablename IN ('notifications', 'notification_settings', 'notification_receipts')
ORDER BY tablename;

-- Check RLS policies created
SELECT
  tablename,
  policyname,
  cmd as operation,
  CASE
    WHEN cmd = 'SELECT' THEN 'Read'
    WHEN cmd = 'INSERT' THEN 'Create'
    WHEN cmd = 'UPDATE' THEN 'Update'
    WHEN cmd = 'DELETE' THEN 'Delete'
    ELSE cmd
  END as permission_type
FROM pg_policies
WHERE tablename IN ('notifications', 'notification_settings', 'notification_receipts')
ORDER BY tablename, cmd;

-- Verify default settings exist for all users
SELECT
  'Default notification settings created for ' || COUNT(*) || ' users' as status
FROM notification_settings;

COMMIT;