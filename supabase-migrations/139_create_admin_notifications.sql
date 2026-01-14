-- =====================================================
-- CREATE ADMIN NOTIFICATIONS SYSTEM
-- =====================================================
-- Real-time notifications for admin panel staff
-- Supports WebSocket delivery, role-based targeting, and department notifications

BEGIN;

-- Create admin_notifications table
CREATE TABLE IF NOT EXISTS admin_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID NOT NULL REFERENCES staff_accounts(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'new_order', 'dispute_opened', 'dispute_escalated', 'report_submitted',
    'payout_requested', 'user_suspended', 'high_value_transaction',
    'escrow_stuck', 'system_alert', 'content_flagged', 'rider_issue',
    'vendor_verification', 'payment_failed'
  )),
  category TEXT NOT NULL DEFAULT 'info' CHECK (category IN ('info', 'warning', 'alert', 'success')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  data JSONB DEFAULT '{}'::jsonb,
  link TEXT,
  icon TEXT DEFAULT 'Bell',
  is_read BOOLEAN DEFAULT FALSE,
  is_deleted BOOLEAN DEFAULT FALSE,
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX idx_admin_notif_staff_id ON admin_notifications(staff_id) WHERE is_deleted = FALSE;
CREATE INDEX idx_admin_notif_is_read ON admin_notifications(is_read) WHERE is_deleted = FALSE;
CREATE INDEX idx_admin_notif_created_at ON admin_notifications(created_at DESC) WHERE is_deleted = FALSE;
CREATE INDEX idx_admin_notif_type ON admin_notifications(type);
CREATE INDEX idx_admin_notif_priority ON admin_notifications(priority);

-- Enable Row Level Security
ALTER TABLE admin_notifications ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Staff can view their own notifications
CREATE POLICY "Staff can view own notifications"
  ON admin_notifications FOR SELECT
  USING (
    staff_id IN (
      SELECT id FROM staff_accounts 
      WHERE id = auth.uid() AND is_active = true
    )
  );

-- RLS Policy: Service role can insert notifications (for system-generated notifications)
CREATE POLICY "Service role can insert notifications"
  ON admin_notifications FOR INSERT
  WITH CHECK (true);

-- RLS Policy: Staff can update their own notifications (mark as read, delete)
CREATE POLICY "Staff can update own notifications"
  ON admin_notifications FOR UPDATE
  USING (
    staff_id IN (
      SELECT id FROM staff_accounts 
      WHERE id = auth.uid() AND is_active = true
    )
  )
  WITH CHECK (
    staff_id IN (
      SELECT id FROM staff_accounts 
      WHERE id = auth.uid() AND is_active = true
    )
  );

-- Create function to auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_admin_notification_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for updated_at
CREATE TRIGGER set_admin_notification_updated_at
  BEFORE UPDATE ON admin_notifications
  FOR EACH ROW
  EXECUTE FUNCTION update_admin_notification_updated_at();

-- Create function to clean up expired notifications
CREATE OR REPLACE FUNCTION cleanup_expired_admin_notifications()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  UPDATE admin_notifications
  SET is_deleted = TRUE
  WHERE expires_at IS NOT NULL 
    AND expires_at < NOW()
    AND is_deleted = FALSE;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMIT;

-- =====================================================
-- VERIFICATION QUERIES
-- =====================================================

-- Check table structure
SELECT 
  column_name, 
  data_type, 
  is_nullable, 
  column_default
FROM information_schema.columns
WHERE table_name = 'admin_notifications'
ORDER BY ordinal_position;

-- Check indexes
SELECT 
  indexname, 
  indexdef
FROM pg_indexes
WHERE tablename = 'admin_notifications';

-- Check RLS policies
SELECT 
  policyname, 
  permissive, 
  roles, 
  cmd
FROM pg_policies
WHERE tablename = 'admin_notifications';

COMMENT ON TABLE admin_notifications IS 'Real-time notifications for admin panel staff (v139)';

