-- ========================================
-- COMPLETE PIN AND BANK ACCOUNT SYSTEM
-- Run this in Supabase SQL Editor
-- ========================================

-- ========================================
-- PART 1: CREATE TABLES
-- ========================================

-- User PINs table
CREATE TABLE IF NOT EXISTS user_pins (
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
CREATE TABLE IF NOT EXISTS pin_verification_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Attempt details
    success BOOLEAN NOT NULL,
    ip_address INET,
    user_agent TEXT,
    
    -- Context
    action_type VARCHAR(50),
    reference_id UUID,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User bank accounts table
CREATE TABLE IF NOT EXISTS user_bank_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Bank details
    account_name VARCHAR(255) NOT NULL,
    bank_name VARCHAR(255) NOT NULL,
    bank_code VARCHAR(50),
    account_number VARCHAR(50) NOT NULL,
    
    -- Account type and currency
    account_type VARCHAR(20) DEFAULT 'savings' CHECK (account_type IN ('savings', 'checking', 'current')),
    currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
    
    -- Verification status
    is_verified BOOLEAN DEFAULT FALSE,
    verification_method VARCHAR(50),
    verified_at TIMESTAMP WITH TIME ZONE,
    
    -- Default account flag
    is_default BOOLEAN DEFAULT FALSE,
    
    -- Additional info
    swift_code VARCHAR(20),
    iban VARCHAR(50),
    routing_number VARCHAR(20),
    branch_name VARCHAR(255),
    branch_code VARCHAR(50),
    
    -- Security and compliance
    is_active BOOLEAN DEFAULT TRUE,
    deactivated_at TIMESTAMP WITH TIME ZONE,
    deactivation_reason TEXT,
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Bank account verification attempts
CREATE TABLE IF NOT EXISTS bank_account_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_account_id UUID NOT NULL REFERENCES user_bank_accounts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Verification details
    verification_type VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'expired')),
    
    -- Micro-deposit verification
    deposit_amount_1 DECIMAL(10,2),
    deposit_amount_2 DECIMAL(10,2),
    attempts_remaining INTEGER DEFAULT 3,
    
    -- External verification
    external_verification_id VARCHAR(255),
    external_response JSONB,
    
    -- Timing
    expires_at TIMESTAMP WITH TIME ZONE,
    verified_at TIMESTAMP WITH TIME ZONE,
    
    -- Failure details
    failure_reason TEXT,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ========================================
-- PART 2: CREATE INDEXES
-- ========================================

CREATE INDEX IF NOT EXISTS idx_user_pins_user_id ON user_pins(user_id);
CREATE INDEX IF NOT EXISTS idx_user_pins_active ON user_pins(is_active, user_id);
CREATE INDEX IF NOT EXISTS idx_pin_attempts_user_id ON pin_verification_attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_pin_attempts_created_at ON pin_verification_attempts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_user_id ON user_bank_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_active ON user_bank_accounts(is_active, user_id);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_default ON user_bank_accounts(is_default, user_id);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_verified ON user_bank_accounts(is_verified, user_id);
CREATE INDEX IF NOT EXISTS idx_bank_verifications_account_id ON bank_account_verifications(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_bank_verifications_user_id ON bank_account_verifications(user_id);

-- ========================================
-- PART 3: CREATE FUNCTIONS
-- ========================================

-- Function to update updated_at for user_pins
CREATE OR REPLACE FUNCTION update_user_pins_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to ensure only one default bank account per user
CREATE OR REPLACE FUNCTION ensure_single_default_bank_account()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_default = TRUE THEN
        UPDATE user_bank_accounts
        SET is_default = FALSE
        WHERE user_id = NEW.user_id AND id != NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to update updated_at for bank accounts
CREATE OR REPLACE FUNCTION update_bank_accounts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ========================================
-- PART 4: CREATE TRIGGERS
-- ========================================

DROP TRIGGER IF EXISTS update_user_pins_updated_at_trigger ON user_pins;
CREATE TRIGGER update_user_pins_updated_at_trigger
    BEFORE UPDATE ON user_pins
    FOR EACH ROW EXECUTE FUNCTION update_user_pins_updated_at();

DROP TRIGGER IF EXISTS ensure_single_default_bank_account_trigger ON user_bank_accounts;
CREATE TRIGGER ensure_single_default_bank_account_trigger
    BEFORE INSERT OR UPDATE ON user_bank_accounts
    FOR EACH ROW
    WHEN (NEW.is_default = TRUE)
    EXECUTE FUNCTION ensure_single_default_bank_account();

DROP TRIGGER IF EXISTS update_bank_accounts_updated_at_trigger ON user_bank_accounts;
CREATE TRIGGER update_bank_accounts_updated_at_trigger
    BEFORE UPDATE ON user_bank_accounts
    FOR EACH ROW EXECUTE FUNCTION update_bank_accounts_updated_at();

DROP TRIGGER IF EXISTS update_bank_verifications_updated_at_trigger ON bank_account_verifications;
CREATE TRIGGER update_bank_verifications_updated_at_trigger
    BEFORE UPDATE ON bank_account_verifications
    FOR EACH ROW EXECUTE FUNCTION update_bank_accounts_updated_at();

-- ========================================
-- PART 5: ENABLE RLS
-- ========================================

ALTER TABLE user_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE pin_verification_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_account_verifications ENABLE ROW LEVEL SECURITY;

-- ========================================
-- PART 6: CREATE RLS POLICIES
-- ========================================

-- USER_PINS POLICIES
DROP POLICY IF EXISTS "Users can view own PIN status" ON user_pins;
CREATE POLICY "Users can view own PIN status"
    ON user_pins FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own PIN" ON user_pins;
CREATE POLICY "Users can update own PIN"
    ON user_pins FOR UPDATE
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own PIN" ON user_pins;
CREATE POLICY "Users can create own PIN"
    ON user_pins FOR INSERT
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access to user_pins" ON user_pins;
CREATE POLICY "Service role full access to user_pins"
    ON user_pins FOR ALL
    USING (auth.role() = 'service_role');

-- PIN_VERIFICATION_ATTEMPTS POLICIES
DROP POLICY IF EXISTS "Users can view own PIN attempts" ON pin_verification_attempts;
CREATE POLICY "Users can view own PIN attempts"
    ON pin_verification_attempts FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can log own PIN attempts" ON pin_verification_attempts;
CREATE POLICY "Users can log own PIN attempts"
    ON pin_verification_attempts FOR INSERT
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access to pin_attempts" ON pin_verification_attempts;
CREATE POLICY "Service role full access to pin_attempts"
    ON pin_verification_attempts FOR ALL
    USING (auth.role() = 'service_role');

-- USER_BANK_ACCOUNTS POLICIES
DROP POLICY IF EXISTS "Users can view own bank accounts" ON user_bank_accounts;
CREATE POLICY "Users can view own bank accounts"
    ON user_bank_accounts FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can add own bank accounts" ON user_bank_accounts;
CREATE POLICY "Users can add own bank accounts"
    ON user_bank_accounts FOR INSERT
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own bank accounts" ON user_bank_accounts;
CREATE POLICY "Users can update own bank accounts"
    ON user_bank_accounts FOR UPDATE
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own bank accounts" ON user_bank_accounts;
CREATE POLICY "Users can delete own bank accounts"
    ON user_bank_accounts FOR DELETE
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access to bank_accounts" ON user_bank_accounts;
CREATE POLICY "Service role full access to bank_accounts"
    ON user_bank_accounts FOR ALL
    USING (auth.role() = 'service_role');

-- BANK_ACCOUNT_VERIFICATIONS POLICIES
DROP POLICY IF EXISTS "Users can view own bank verifications" ON bank_account_verifications;
CREATE POLICY "Users can view own bank verifications"
    ON bank_account_verifications FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can create own bank verifications" ON bank_account_verifications;
CREATE POLICY "Users can create own bank verifications"
    ON bank_account_verifications FOR INSERT
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own bank verifications" ON bank_account_verifications;
CREATE POLICY "Users can update own bank verifications"
    ON bank_account_verifications FOR UPDATE
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role full access to bank_verifications" ON bank_account_verifications;
CREATE POLICY "Service role full access to bank_verifications"
    ON bank_account_verifications FOR ALL
    USING (auth.role() = 'service_role');

-- ========================================
-- PART 7: GRANT PERMISSIONS
-- ========================================

GRANT SELECT, INSERT, UPDATE ON user_pins TO authenticated;
GRANT SELECT, INSERT ON pin_verification_attempts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_bank_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON bank_account_verifications TO authenticated;

GRANT ALL ON user_pins TO service_role;
GRANT ALL ON pin_verification_attempts TO service_role;
GRANT ALL ON user_bank_accounts TO service_role;
GRANT ALL ON bank_account_verifications TO service_role;

-- ========================================
-- MIGRATION COMPLETE
-- ========================================

