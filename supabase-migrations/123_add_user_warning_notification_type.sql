-- Migration: Add 'user_warning' to notifications type constraint
-- Description: Allow notifications table to accept 'user_warning' type
-- Date: 2025-12-14

-- Drop the existing check constraint
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;

-- Add new constraint with all existing types plus 'user_warning'
-- Note: Includes all types from migration 068 (connection_request, connection_accepted, ai_checkin, ai_reminder, ai_engagement)
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
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
  'ai_engagement',
  'user_warning'
));

-- Add comment
COMMENT ON COLUMN notifications.type IS 'Notification type: order, social, connection_request, connection_accepted, promotion, system, delivery, live, payment, chat, ai_checkin, ai_reminder, ai_engagement, user_warning';

