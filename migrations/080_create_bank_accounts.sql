-- Migration: Create User Bank Accounts System
-- Date: 2025-10-23
-- Description: Add bank account management for withdrawals/payouts

-- User bank accounts table
CREATE TABLE user_bank_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Bank details
    account_name VARCHAR(255) NOT NULL,
    bank_name VARCHAR(255) NOT NULL,
    bank_code VARCHAR(50), -- Bank code for automated transfers
    account_number VARCHAR(50) NOT NULL,
    
    -- Account type and currency
    account_type VARCHAR(20) DEFAULT 'savings' CHECK (account_type IN ('savings', 'checking', 'current')),
    currency VARCHAR(3) NOT NULL DEFAULT 'NGN', -- ISO currency code
    
    -- Verification status
    is_verified BOOLEAN DEFAULT FALSE,
    verification_method VARCHAR(50), -- 'micro_deposit', 'instant', 'manual'
    verified_at TIMESTAMP WITH TIME ZONE,
    
    -- Default account flag
    is_default BOOLEAN DEFAULT FALSE,
    
    -- Additional info
    swift_code VARCHAR(20), -- For international transfers
    iban VARCHAR(50), -- For international transfers
    routing_number VARCHAR(20), -- For US accounts
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
CREATE TABLE bank_account_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bank_account_id UUID NOT NULL REFERENCES user_bank_accounts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Verification details
    verification_type VARCHAR(50) NOT NULL, -- 'micro_deposit', 'instant', 'manual'
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed', 'expired')),
    
    -- Micro-deposit verification
    deposit_amount_1 DECIMAL(10,2), -- First micro-deposit amount
    deposit_amount_2 DECIMAL(10,2), -- Second micro-deposit amount
    attempts_remaining INTEGER DEFAULT 3,
    
    -- External verification
    external_verification_id VARCHAR(255), -- ID from payment provider
    external_response JSONB,
    
    -- Timing
    expires_at TIMESTAMP WITH TIME ZONE,
    verified_at TIMESTAMP WITH TIME ZONE,
    
    -- Failure details
    failure_reason TEXT,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_bank_accounts_user_id ON user_bank_accounts(user_id);
CREATE INDEX idx_bank_accounts_active ON user_bank_accounts(is_active, user_id);
CREATE INDEX idx_bank_accounts_default ON user_bank_accounts(is_default, user_id);
CREATE INDEX idx_bank_accounts_verified ON user_bank_accounts(is_verified, user_id);
CREATE INDEX idx_bank_verifications_account_id ON bank_account_verifications(bank_account_id);
CREATE INDEX idx_bank_verifications_user_id ON bank_account_verifications(user_id);

-- Function to ensure only one default account per user
CREATE OR REPLACE FUNCTION ensure_single_default_bank_account()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_default = TRUE THEN
        -- Unset all other default accounts for this user
        UPDATE user_bank_accounts
        SET is_default = FALSE
        WHERE user_id = NEW.user_id AND id != NEW.id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for default account
CREATE TRIGGER ensure_single_default_bank_account_trigger
    BEFORE INSERT OR UPDATE ON user_bank_accounts
    FOR EACH ROW
    WHEN (NEW.is_default = TRUE)
    EXECUTE FUNCTION ensure_single_default_bank_account();

-- Function to update updated_at
CREATE OR REPLACE FUNCTION update_bank_accounts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_bank_accounts_updated_at_trigger
    BEFORE UPDATE ON user_bank_accounts
    FOR EACH ROW EXECUTE FUNCTION update_bank_accounts_updated_at();

CREATE TRIGGER update_bank_verifications_updated_at_trigger
    BEFORE UPDATE ON bank_account_verifications
    FOR EACH ROW EXECUTE FUNCTION update_bank_accounts_updated_at();

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON user_bank_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON bank_account_verifications TO authenticated;
GRANT ALL ON user_bank_accounts TO service_role;
GRANT ALL ON bank_account_verifications TO service_role;

COMMIT;

