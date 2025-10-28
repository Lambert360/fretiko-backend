-- Migration: Add RLS Policies for PINs and Bank Accounts
-- Date: 2025-10-23
-- Description: Row-level security for user_pins and user_bank_accounts

-- Enable RLS
ALTER TABLE user_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE pin_verification_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_account_verifications ENABLE ROW LEVEL SECURITY;

-- ======================
-- USER_PINS POLICIES
-- ======================

-- Users can view their own PIN record (but not the hash)
CREATE POLICY "Users can view own PIN status"
    ON user_pins FOR SELECT
    USING (auth.uid() = user_id);

-- Users can update their own PIN
CREATE POLICY "Users can update own PIN"
    ON user_pins FOR UPDATE
    USING (auth.uid() = user_id);

-- Users can insert their own PIN (first time setup)
CREATE POLICY "Users can create own PIN"
    ON user_pins FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Service role has full access
CREATE POLICY "Service role full access to user_pins"
    ON user_pins FOR ALL
    USING (auth.role() = 'service_role');

-- ======================
-- PIN_VERIFICATION_ATTEMPTS POLICIES
-- ======================

-- Users can view their own verification attempts
CREATE POLICY "Users can view own PIN attempts"
    ON pin_verification_attempts FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own verification attempts
CREATE POLICY "Users can log own PIN attempts"
    ON pin_verification_attempts FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Service role has full access
CREATE POLICY "Service role full access to pin_attempts"
    ON pin_verification_attempts FOR ALL
    USING (auth.role() = 'service_role');

-- ======================
-- USER_BANK_ACCOUNTS POLICIES
-- ======================

-- Users can view their own bank accounts
CREATE POLICY "Users can view own bank accounts"
    ON user_bank_accounts FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own bank accounts
CREATE POLICY "Users can add own bank accounts"
    ON user_bank_accounts FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own bank accounts
CREATE POLICY "Users can update own bank accounts"
    ON user_bank_accounts FOR UPDATE
    USING (auth.uid() = user_id);

-- Users can delete their own bank accounts
CREATE POLICY "Users can delete own bank accounts"
    ON user_bank_accounts FOR DELETE
    USING (auth.uid() = user_id);

-- Service role has full access
CREATE POLICY "Service role full access to bank_accounts"
    ON user_bank_accounts FOR ALL
    USING (auth.role() = 'service_role');

-- ======================
-- BANK_ACCOUNT_VERIFICATIONS POLICIES
-- ======================

-- Users can view their own verification records
CREATE POLICY "Users can view own bank verifications"
    ON bank_account_verifications FOR SELECT
    USING (auth.uid() = user_id);

-- Users can insert their own verification records
CREATE POLICY "Users can create own bank verifications"
    ON bank_account_verifications FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own verification records
CREATE POLICY "Users can update own bank verifications"
    ON bank_account_verifications FOR UPDATE
    USING (auth.uid() = user_id);

-- Service role has full access
CREATE POLICY "Service role full access to bank_verifications"
    ON bank_account_verifications FOR ALL
    USING (auth.role() = 'service_role');

COMMIT;

