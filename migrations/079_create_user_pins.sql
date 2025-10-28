-- Migration: Create User PIN System
-- Date: 2025-10-23
-- Description: Add PIN verification for secure wallet operations

-- User PINs table
CREATE TABLE user_pins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- PIN hash (never store plain text)
    pin_hash VARCHAR(255) NOT NULL,
    pin_salt VARCHAR(255) NOT NULL,
    
    -- PIN metadata
    is_active BOOLEAN DEFAULT TRUE,
    failed_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMP WITH TIME ZONE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    
    -- Security
    requires_reset BOOLEAN DEFAULT FALSE,
    reset_token VARCHAR(255),
    reset_token_expires_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(user_id)
);

-- PIN verification attempts log
CREATE TABLE pin_verification_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Attempt details
    success BOOLEAN NOT NULL,
    ip_address INET,
    user_agent TEXT,
    
    -- Context
    action_type VARCHAR(50), -- 'withdrawal', 'account_change', 'purchase'
    reference_id UUID, -- ID of the related action
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_user_pins_user_id ON user_pins(user_id);
CREATE INDEX idx_user_pins_active ON user_pins(is_active, user_id);
CREATE INDEX idx_pin_attempts_user_id ON pin_verification_attempts(user_id);
CREATE INDEX idx_pin_attempts_created_at ON pin_verification_attempts(created_at DESC);

-- Function to update updated_at
CREATE OR REPLACE FUNCTION update_user_pins_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for updated_at
CREATE TRIGGER update_user_pins_updated_at_trigger
    BEFORE UPDATE ON user_pins
    FOR EACH ROW EXECUTE FUNCTION update_user_pins_updated_at();

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON user_pins TO authenticated;
GRANT SELECT, INSERT ON pin_verification_attempts TO authenticated;
GRANT ALL ON user_pins TO service_role;
GRANT ALL ON pin_verification_attempts TO service_role;

COMMIT;

