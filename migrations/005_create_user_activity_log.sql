-- Create user_activity_log table for activity-based authentication tracking
-- This table tracks user actions to determine session activity and security events

CREATE TABLE IF NOT EXISTS user_activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  activity_type VARCHAR(50) NOT NULL,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  metadata JSONB DEFAULT '{}',
  
  -- Constraints
  CONSTRAINT user_activity_log_user_id_check CHECK (user_id IS NOT NULL),
  CONSTRAINT user_activity_log_activity_type_check CHECK (
    activity_type IN (
      'login', 'logout', 'token_refresh', 'profile_update', 
      'post_create', 'message_send', 'purchase', 'password_change',
      'email_change', 'security_setting_change', 'api_call', 'app_open'
    )
  )
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_activity_log_user_id ON user_activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_user_activity_log_timestamp ON user_activity_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_user_activity_log_activity_type ON user_activity_log(activity_type);
CREATE INDEX IF NOT EXISTS idx_user_activity_log_user_timestamp ON user_activity_log(user_id, timestamp DESC);

-- Composite index for recent activity queries
CREATE INDEX IF NOT EXISTS idx_user_activity_log_recent_activity ON user_activity_log(user_id, timestamp DESC, activity_type);

-- Row Level Security (RLS)
ALTER TABLE user_activity_log ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own activity logs" ON user_activity_log
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own activity logs" ON user_activity_log
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Service role policy for backend operations
CREATE POLICY "Service role can manage all activity logs" ON user_activity_log
  FOR ALL USING (current_setting('app.config.backend_role', true) = 'service');

-- Function to log user activity
CREATE OR REPLACE FUNCTION log_user_activity(
  p_user_id UUID,
  p_activity_type VARCHAR(50),
  p_metadata JSONB DEFAULT '{}'
)
RETURNS void AS $$
BEGIN
  INSERT INTO user_activity_log (user_id, activity_type, metadata)
  VALUES (p_user_id, p_activity_type, p_metadata);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get user's last activity timestamp
CREATE OR REPLACE FUNCTION get_user_last_activity(
  p_user_id UUID,
  p_activity_types VARCHAR(50)[] DEFAULT ARRAY['login', 'token_refresh', 'api_call', 'app_open']
)
RETURNS TIMESTAMP WITH TIME ZONE AS $$
DECLARE
  last_activity TIMESTAMP WITH TIME ZONE;
BEGIN
  SELECT timestamp INTO last_activity
  FROM user_activity_log
  WHERE user_id = p_user_id 
    AND activity_type = ANY(p_activity_types)
  ORDER BY timestamp DESC
  LIMIT 1;
  
  RETURN COALESCE(last_activity, '1970-01-01'::TIMESTAMP WITH TIME ZONE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if user is inactive (30 days)
CREATE OR REPLACE FUNCTION is_user_inactive(
  p_user_id UUID,
  p_days INTEGER DEFAULT 30
)
RETURNS BOOLEAN AS $$
DECLARE
  last_activity TIMESTAMP WITH TIME ZONE;
  inactive_threshold TIMESTAMP WITH TIME ZONE;
BEGIN
  last_activity := get_user_last_activity(p_user_id);
  inactive_threshold := NOW() - (p_days || ' days')::INTERVAL;
  
  RETURN last_activity < inactive_threshold;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to clean up old activity logs (keep last 90 days)
CREATE OR REPLACE FUNCTION cleanup_old_activity_logs()
RETURNS void AS $$
BEGIN
  DELETE FROM user_activity_log 
  WHERE timestamp < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;
