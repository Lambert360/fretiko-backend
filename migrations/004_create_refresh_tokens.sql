-- Create refresh_tokens table for modern authentication system
-- This table stores long-lived refresh tokens for session management

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  token_hash VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_used_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  is_revoked BOOLEAN DEFAULT FALSE,
  device_info JSONB DEFAULT '{}',
  ip_address INET,
  
  -- Constraints
  CONSTRAINT refresh_tokens_user_id_check CHECK (user_id IS NOT NULL),
  CONSTRAINT refresh_tokens_token_hash_check CHECK (length(token_hash) >= 10),
  CONSTRAINT refresh_tokens_expires_at_check CHECK (expires_at > created_at)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_is_revoked ON refresh_tokens(is_revoked);

-- Row Level Security (RLS)
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own refresh tokens" ON refresh_tokens
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own refresh tokens" ON refresh_tokens
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own refresh tokens" ON refresh_tokens
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own refresh tokens" ON refresh_tokens
  FOR DELETE USING (auth.uid() = user_id);

-- Service role policy for backend operations
CREATE POLICY "Service role can manage all refresh tokens" ON refresh_tokens
  FOR ALL USING (current_setting('app.config.backend_role', true) = 'service');

-- Function to clean up expired refresh tokens
CREATE OR REPLACE FUNCTION cleanup_expired_refresh_tokens()
RETURNS void AS $$
BEGIN
  DELETE FROM refresh_tokens 
  WHERE expires_at < NOW() OR is_revoked = TRUE;
END;
$$ LANGUAGE plpgsql;

-- Create a trigger to automatically clean up expired tokens (optional)
-- This can be called periodically instead of real-time trigger for performance
-- CREATE OR REPLACE FUNCTION trigger_cleanup_expired_tokens()
-- RETURNS trigger AS $$
-- BEGIN
--   PERFORM cleanup_expired_refresh_tokens();
--   RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql;
