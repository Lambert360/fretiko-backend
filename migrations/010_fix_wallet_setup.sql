-- Migration: Fix Wallet Setup Issues
-- Date: 2025-08-28
-- Description: Ensure all users have wallets and fix any missing records

BEGIN;

-- ================================
-- ENSURE ALL TABLES EXIST
-- ================================

-- Check if wallets table exists, if not create it
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'wallets') THEN
        RAISE NOTICE 'Wallets table does not exist, creating it...';
        
        -- Create wallets table
        CREATE TABLE wallets (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
            
            -- Freti balances (using DECIMAL for precision)
            available_balance DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
            escrow_balance DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
            pending_withdrawal DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
            
            -- Local currency preference
            preferred_currency VARCHAR(3) DEFAULT 'USD',
            
            -- KYC and limits
            kyc_status VARCHAR(20) DEFAULT 'pending' CHECK (kyc_status IN ('pending', 'approved', 'rejected')),
            daily_deposit_limit DECIMAL(18,6) DEFAULT 1000.000000,
            daily_withdrawal_limit DECIMAL(18,6) DEFAULT 500.000000,
            
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            
            UNIQUE(user_id)
        );

        -- Enable RLS
        ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
        
        -- Create RLS policies
        CREATE POLICY wallet_select_own ON wallets 
        FOR SELECT TO authenticated 
        USING (user_id = auth.uid());

        CREATE POLICY wallet_update_own ON wallets 
        FOR UPDATE TO authenticated 
        USING (user_id = auth.uid());

        CREATE POLICY wallet_service_all ON wallets 
        FOR ALL TO service_role 
        USING (true);

        -- Grant permissions
        GRANT SELECT, INSERT, UPDATE, DELETE ON wallets TO authenticated;
        GRANT ALL ON wallets TO service_role;
        
        RAISE NOTICE 'Wallets table created successfully';
    END IF;
END $$;

-- Check if trust_scores table exists
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'trust_scores') THEN
        RAISE NOTICE 'Trust_scores table does not exist, creating it...';
        
        CREATE TABLE trust_scores (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
            
            -- Trust metrics
            vendor_trust_score INTEGER DEFAULT 0,
            rider_trust_score INTEGER DEFAULT 0,
            buyer_trust_score INTEGER DEFAULT 0,
            
            -- Factors contributing to trust
            completed_orders INTEGER DEFAULT 0,
            successful_deliveries INTEGER DEFAULT 0,
            dispute_count INTEGER DEFAULT 0,
            refund_rate DECIMAL(5,2) DEFAULT 0.00,
            
            -- KYC status affects trust
            kyc_verified BOOLEAN DEFAULT FALSE,
            phone_verified BOOLEAN DEFAULT FALSE,
            email_verified BOOLEAN DEFAULT FALSE,
            
            -- Timestamps
            last_calculated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            
            UNIQUE(user_id)
        );

        -- Enable RLS
        ALTER TABLE trust_scores ENABLE ROW LEVEL SECURITY;
        
        -- Create RLS policies
        CREATE POLICY trust_scores_select_own ON trust_scores 
        FOR SELECT TO authenticated 
        USING (user_id = auth.uid());

        CREATE POLICY trust_scores_service_all ON trust_scores 
        FOR ALL TO service_role 
        USING (true);

        -- Grant permissions
        GRANT SELECT ON trust_scores TO authenticated;
        GRANT ALL ON trust_scores TO service_role;
        
        RAISE NOTICE 'Trust_scores table created successfully';
    END IF;
END $$;

-- ================================
-- CREATE MISSING WALLET RECORDS
-- ================================

-- Insert wallets for users who don't have them
INSERT INTO wallets (
    user_id, 
    available_balance, 
    escrow_balance, 
    pending_withdrawal,
    preferred_currency,
    kyc_status,
    daily_deposit_limit,
    daily_withdrawal_limit
)
SELECT 
    up.id,
    0.000000,
    0.000000, 
    0.000000,
    'USD',
    'pending',
    1000.000000,
    500.000000
FROM user_profiles up
WHERE NOT EXISTS (
    SELECT 1 FROM wallets w WHERE w.user_id = up.id
)
ON CONFLICT (user_id) DO NOTHING;

-- Insert trust scores for users who don't have them
INSERT INTO trust_scores (
    user_id,
    vendor_trust_score,
    rider_trust_score,
    buyer_trust_score,
    completed_orders,
    successful_deliveries,
    dispute_count,
    refund_rate,
    kyc_verified,
    phone_verified,
    email_verified
)
SELECT 
    up.id,
    0,
    0,
    0,
    0,
    0,
    0,
    0.00,
    false,
    false,
    false
FROM user_profiles up
WHERE NOT EXISTS (
    SELECT 1 FROM trust_scores ts WHERE ts.user_id = up.id
)
ON CONFLICT (user_id) DO NOTHING;

-- ================================
-- CREATE AUTO-CREATION TRIGGERS
-- ================================

-- Function to create wallet for new users
CREATE OR REPLACE FUNCTION create_user_wallet()
RETURNS TRIGGER AS $$
BEGIN
    -- Create wallet
    INSERT INTO wallets (
        user_id,
        available_balance,
        escrow_balance,
        pending_withdrawal,
        preferred_currency,
        kyc_status,
        daily_deposit_limit,
        daily_withdrawal_limit
    ) VALUES (
        NEW.id,
        0.000000,
        0.000000,
        0.000000,
        'USD',
        'pending',
        1000.000000,
        500.000000
    ) ON CONFLICT (user_id) DO NOTHING;

    -- Create trust score
    INSERT INTO trust_scores (
        user_id,
        vendor_trust_score,
        rider_trust_score,
        buyer_trust_score
    ) VALUES (
        NEW.id,
        0,
        0,
        0
    ) ON CONFLICT (user_id) DO NOTHING;
    
    RAISE NOTICE 'Created wallet and trust score for user: %', NEW.id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS create_user_wallet_trigger ON user_profiles;

-- Create trigger to auto-create wallet for new users
CREATE TRIGGER create_user_wallet_trigger
    AFTER INSERT ON user_profiles
    FOR EACH ROW EXECUTE FUNCTION create_user_wallet();

-- ================================
-- VERIFY DATA INTEGRITY
-- ================================

-- Report on wallet creation
DO $$ 
DECLARE
    user_count INTEGER;
    wallet_count INTEGER;
    trust_count INTEGER;
    missing_wallets INTEGER;
    missing_trust INTEGER;
BEGIN
    SELECT COUNT(*) INTO user_count FROM user_profiles;
    SELECT COUNT(*) INTO wallet_count FROM wallets;
    SELECT COUNT(*) INTO trust_count FROM trust_scores;
    
    SELECT COUNT(*) INTO missing_wallets 
    FROM user_profiles up 
    WHERE NOT EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = up.id);
    
    SELECT COUNT(*) INTO missing_trust
    FROM user_profiles up 
    WHERE NOT EXISTS (SELECT 1 FROM trust_scores ts WHERE ts.user_id = up.id);
    
    RAISE NOTICE '=== WALLET SETUP REPORT ===';
    RAISE NOTICE 'Total users: %', user_count;
    RAISE NOTICE 'Total wallets: %', wallet_count;
    RAISE NOTICE 'Total trust scores: %', trust_count;
    RAISE NOTICE 'Missing wallets: %', missing_wallets;
    RAISE NOTICE 'Missing trust scores: %', missing_trust;
    
    IF missing_wallets > 0 OR missing_trust > 0 THEN
        RAISE WARNING 'Some users still missing wallet data!';
    ELSE
        RAISE NOTICE 'All users have wallets and trust scores!';
    END IF;
END $$;

-- ================================
-- ADDITIONAL REQUIRED TABLES
-- ================================

-- Create wallet_ledger table if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'wallet_ledger') THEN
        CREATE TABLE wallet_ledger (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            wallet_id UUID NOT NULL,
            user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
            
            -- Transaction details
            transaction_type VARCHAR(50) NOT NULL CHECK (transaction_type IN (
                'deposit_mint', 'withdrawal_burn', 'purchase_hold', 'escrow_release', 
                'escrow_refund', 'admin_adjustment', 'fee_deduction', 'reward_credit'
            )),
            
            -- Amounts
            available_delta DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
            escrow_delta DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
            pending_withdrawal_delta DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
            
            -- Balances after transaction
            available_balance_after DECIMAL(18,6) NOT NULL,
            escrow_balance_after DECIMAL(18,6) NOT NULL,
            pending_withdrawal_after DECIMAL(18,6) NOT NULL,
            
            -- Reference data
            reference_type VARCHAR(50),
            reference_id UUID,
            idempotency_key VARCHAR(255) UNIQUE,
            
            -- Metadata
            description TEXT,
            metadata JSONB DEFAULT '{}',
            created_by UUID REFERENCES user_profiles(id),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        -- Enable RLS
        ALTER TABLE wallet_ledger ENABLE ROW LEVEL SECURITY;
        
        -- Users can only see their own ledger entries
        CREATE POLICY wallet_ledger_select_own ON wallet_ledger 
        FOR SELECT TO authenticated 
        USING (user_id = auth.uid());

        -- Service role can do everything
        CREATE POLICY wallet_ledger_service_all ON wallet_ledger 
        FOR ALL TO service_role 
        USING (true);
        
        -- Grant permissions
        GRANT SELECT ON wallet_ledger TO authenticated;
        GRANT ALL ON wallet_ledger TO service_role;
        
        RAISE NOTICE 'Wallet_ledger table created successfully';
    END IF;
END $$;

-- Create risk_flags table if it doesn't exist  
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'risk_flags') THEN
        CREATE TABLE risk_flags (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
            
            -- Flag details
            flag_type VARCHAR(50) NOT NULL,
            flag_reason TEXT NOT NULL,
            severity VARCHAR(20) NOT NULL DEFAULT 'medium',
            
            -- Status
            is_active BOOLEAN DEFAULT TRUE,
            resolved_at TIMESTAMP WITH TIME ZONE,
            
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        -- Enable RLS
        ALTER TABLE risk_flags ENABLE ROW LEVEL SECURITY;
        
        -- Users can only see their own risk flags
        CREATE POLICY risk_flags_select_own ON risk_flags 
        FOR SELECT TO authenticated 
        USING (user_id = auth.uid());

        -- Service role can do everything
        CREATE POLICY risk_flags_service_all ON risk_flags 
        FOR ALL TO service_role 
        USING (true);
        
        -- Grant permissions
        GRANT SELECT ON risk_flags TO authenticated;
        GRANT ALL ON risk_flags TO service_role;
        
        RAISE NOTICE 'Risk_flags table created successfully';
    END IF;
END $$;

-- ================================
-- FINAL VERIFICATION
-- ================================

-- Ensure service_role has all necessary permissions
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Create indexes for performance if they don't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_wallets_user_id') THEN
        CREATE INDEX idx_wallets_user_id ON wallets(user_id);
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_trust_scores_user_id') THEN
        CREATE INDEX idx_trust_scores_user_id ON trust_scores(user_id);
    END IF;
END $$;

RAISE NOTICE '=== WALLET MIGRATION COMPLETE ===';
RAISE NOTICE 'All wallet tables created and populated';
RAISE NOTICE 'RLS policies enabled and configured';
RAISE NOTICE 'Triggers created for auto-wallet creation';

COMMIT;