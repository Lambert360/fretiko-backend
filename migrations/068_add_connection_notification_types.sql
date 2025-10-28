-- Migration: Add connection notification types
-- Date: 2025-10-18
-- Description: Add 'connection_request' and 'connection_accepted' to notification types enum

-- Drop the old constraint
ALTER TABLE notifications
DROP CONSTRAINT IF EXISTS notifications_type_check;

-- Add new constraint with additional notification types
ALTER TABLE notifications
ADD CONSTRAINT notifications_type_check
CHECK (type IN (
  'order',
  'social',
  'connection_request',
  'connection_accepted',
  'promotion',
  'system',
  'delivery',
  'live',
  'payment',
  'chat',
  'ai_checkin',
  'ai_reminder',
  'ai_engagement'
));

-- Add connection notification settings to notification_settings table if columns don't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notification_settings' AND column_name='connection_notifications') THEN
    ALTER TABLE notification_settings
    ADD COLUMN connection_notifications BOOLEAN DEFAULT TRUE;
  END IF;
END $$;

-- Add comment for documentation
COMMENT ON CONSTRAINT notifications_type_check ON notifications IS 'Valid notification types including connection-related notifications';

-- Drop and recreate user_notification_stats view to ADD connection notification columns
-- (keeping all existing columns in the same order, adding new ones at the end)
DROP VIEW IF EXISTS user_notification_stats;

CREATE VIEW user_notification_stats AS
SELECT
  n.user_id,
  COUNT(*) as total_notifications,
  COUNT(CASE WHEN NOT n.is_read THEN 1 END) as unread_count,
  COUNT(CASE WHEN n.type = 'order' AND NOT n.is_read THEN 1 END) as unread_orders,
  COUNT(CASE WHEN n.type = 'social' AND NOT n.is_read THEN 1 END) as unread_social,
  COUNT(CASE WHEN n.type = 'live' AND NOT n.is_read THEN 1 END) as unread_live,
  COUNT(CASE WHEN n.type = 'delivery' AND NOT n.is_read THEN 1 END) as unread_delivery,
  COUNT(CASE WHEN n.type = 'payment' AND NOT n.is_read THEN 1 END) as unread_payment,
  COUNT(CASE WHEN n.type = 'chat' AND NOT n.is_read THEN 1 END) as unread_chat,
  MAX(n.created_at) as latest_notification_at,
  COUNT(CASE WHEN n.type = 'connection_request' AND NOT n.is_read THEN 1 END) as unread_connection_requests,
  COUNT(CASE WHEN n.type = 'connection_accepted' AND NOT n.is_read THEN 1 END) as unread_connection_accepted
FROM notifications n
WHERE n.is_deleted = FALSE
GROUP BY n.user_id;
