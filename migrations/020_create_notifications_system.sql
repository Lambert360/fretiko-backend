-- Migration: Create notifications system
-- Date: 2025-09-02
-- Description: Create notifications tables for real-time user notifications

-- ============================================
-- 1. CORE NOTIFICATIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  
  -- Notification content matching frontend types
  type VARCHAR(50) NOT NULL CHECK (type IN ('order', 'social', 'promotion', 'system', 'delivery', 'live', 'payment', 'chat')),
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  
  -- Metadata and display info
  data JSONB DEFAULT '{}', -- Extra data like order_id, user_id, product_id, etc.
  avatar_url TEXT,
  badge VARCHAR(50), -- SHIPPED, LIVE, PAID, AI DEALS, etc.
  priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  
  -- State management  
  is_read BOOLEAN DEFAULT FALSE,
  is_deleted BOOLEAN DEFAULT FALSE,
  
  -- Action buttons (matches frontend structure)
  has_actions BOOLEAN DEFAULT FALSE,
  action_buttons JSONB DEFAULT '[]', -- [{label: "Track Package", type: "primary"}]
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE, -- For temporary notifications like live streams
  
  -- Validation
  CONSTRAINT valid_action_buttons CHECK (
    action_buttons IS NULL OR 
    jsonb_typeof(action_buttons) = 'array'
  )
);

-- ============================================
-- 2. USER NOTIFICATION SETTINGS
-- ============================================  
CREATE TABLE IF NOT EXISTS notification_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  
  -- Global notification preferences
  push_enabled BOOLEAN DEFAULT TRUE,
  email_enabled BOOLEAN DEFAULT TRUE,
  in_app_enabled BOOLEAN DEFAULT TRUE,
  
  -- Type-specific preferences (matching frontend categories)
  order_notifications BOOLEAN DEFAULT TRUE,
  social_notifications BOOLEAN DEFAULT TRUE,
  promotion_notifications BOOLEAN DEFAULT TRUE,
  system_notifications BOOLEAN DEFAULT TRUE,
  delivery_notifications BOOLEAN DEFAULT TRUE,
  live_notifications BOOLEAN DEFAULT TRUE,
  payment_notifications BOOLEAN DEFAULT TRUE,
  chat_notifications BOOLEAN DEFAULT TRUE,
  
  -- Quiet hours for push notifications
  quiet_hours_enabled BOOLEAN DEFAULT FALSE,
  quiet_start_time TIME,
  quiet_end_time TIME,
  quiet_timezone VARCHAR(50) DEFAULT 'UTC',
  
  -- Device tokens for push notifications
  expo_push_tokens JSONB DEFAULT '[]', -- Array of Expo push tokens
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- One settings record per user
  UNIQUE(user_id)
);

-- ============================================
-- 3. NOTIFICATION READ RECEIPTS (for group/broadcast notifications)
-- ============================================
CREATE TABLE IF NOT EXISTS notification_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  read_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Action taken (if any)
  action_taken VARCHAR(100), -- "Track Package", "View Deal", etc.
  
  -- Prevent duplicate receipts
  UNIQUE(notification_id, user_id)
);

-- ============================================
-- 4. PERFORMANCE INDEXES
-- ============================================
-- Core notification indexes
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read) WHERE is_read = FALSE AND is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_notifications_user_type ON notifications(user_id, type);
CREATE INDEX IF NOT EXISTS idx_notifications_priority ON notifications(priority) WHERE priority = 'high';
CREATE INDEX IF NOT EXISTS idx_notifications_expires_at ON notifications(expires_at) WHERE expires_at IS NOT NULL;

-- Settings indexes
CREATE INDEX IF NOT EXISTS idx_notification_settings_user_id ON notification_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_settings_push_enabled ON notification_settings(push_enabled) WHERE push_enabled = TRUE;

-- Receipts indexes
CREATE INDEX IF NOT EXISTS idx_notification_receipts_notification_id ON notification_receipts(notification_id);
CREATE INDEX IF NOT EXISTS idx_notification_receipts_user_id ON notification_receipts(user_id);

-- ============================================
-- 5. TIMESTAMP UPDATE TRIGGERS
-- ============================================
CREATE OR REPLACE FUNCTION update_notifications_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_notifications_updated_at
  BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION update_notifications_updated_at();

CREATE TRIGGER trigger_notification_settings_updated_at
  BEFORE UPDATE ON notification_settings
  FOR EACH ROW EXECUTE FUNCTION update_notifications_updated_at();

-- ============================================
-- 6. USEFUL VIEWS FOR PERFORMANCE
-- ============================================
-- User notification stats view (matches frontend needs)
CREATE OR REPLACE VIEW user_notification_stats AS
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
  MAX(n.created_at) as latest_notification_at
FROM notifications n
WHERE n.is_deleted = FALSE
GROUP BY n.user_id;

-- Recent active notifications (last 30 days, not deleted)
CREATE OR REPLACE VIEW recent_notifications AS
SELECT *
FROM notifications
WHERE created_at > NOW() - INTERVAL '30 days'
  AND is_deleted = FALSE
  AND (expires_at IS NULL OR expires_at > NOW())
ORDER BY created_at DESC;

-- High priority unread notifications
CREATE OR REPLACE VIEW urgent_notifications AS
SELECT *
FROM notifications
WHERE is_read = FALSE 
  AND is_deleted = FALSE
  AND priority = 'high'
  AND (expires_at IS NULL OR expires_at > NOW())
ORDER BY created_at DESC;

-- ============================================
-- 7. ROW LEVEL SECURITY (RLS)
-- ============================================
-- Enable RLS on all tables
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_receipts ENABLE ROW LEVEL SECURITY;

-- Notifications policies
CREATE POLICY "Users can view own notifications" ON notifications
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own notifications" ON notifications
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "System can insert notifications" ON notifications
    FOR INSERT WITH CHECK (true); -- Backend service inserts notifications

-- Notification settings policies  
CREATE POLICY "Users can view own settings" ON notification_settings
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own settings" ON notification_settings
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own settings" ON notification_settings
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Receipts policies
CREATE POLICY "Users can view own receipts" ON notification_receipts
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own receipts" ON notification_receipts
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ============================================
-- 8. AUTOMATIC SETTINGS CREATION
-- ============================================
-- Function to create default notification settings for new users
CREATE OR REPLACE FUNCTION create_default_notification_settings()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO notification_settings (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING; -- Prevent duplicates
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create settings when user profile is created
CREATE TRIGGER trigger_create_notification_settings
  AFTER INSERT ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION create_default_notification_settings();

-- ============================================
-- 9. CLEANUP FUNCTIONS
-- ============================================
-- Function to clean up expired notifications
CREATE OR REPLACE FUNCTION cleanup_expired_notifications()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM notifications 
  WHERE expires_at IS NOT NULL 
    AND expires_at < NOW();
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Function to mark old notifications as deleted (soft delete)
CREATE OR REPLACE FUNCTION archive_old_notifications()
RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE notifications 
  SET is_deleted = TRUE 
  WHERE created_at < NOW() - INTERVAL '90 days'
    AND is_deleted = FALSE;
  
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 10. CREATE DEFAULT SETTINGS FOR EXISTING USERS
-- ============================================
-- Insert default notification settings for any existing users
INSERT INTO notification_settings (user_id)
SELECT id FROM user_profiles
ON CONFLICT (user_id) DO NOTHING;

-- ============================================
-- 11. VERIFICATION QUERIES
-- ============================================
-- Verify tables created successfully
SELECT 'notifications table created with ' || 
       (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'notifications') || 
       ' columns' as status;

SELECT 'notification_settings table created with ' || 
       (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'notification_settings') || 
       ' columns' as status;

SELECT 'notification_receipts table created with ' || 
       (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'notification_receipts') || 
       ' columns' as status;

-- Verify indexes created
SELECT 'Created ' || COUNT(*) || ' notification indexes' as status
FROM pg_indexes 
WHERE tablename IN ('notifications', 'notification_settings', 'notification_receipts');

-- Verify views created
SELECT 'Created notification views: ' || string_agg(viewname, ', ') as status
FROM pg_views 
WHERE viewname LIKE '%notification%';

COMMIT;