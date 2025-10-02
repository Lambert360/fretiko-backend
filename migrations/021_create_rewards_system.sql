-- Migration: Create Rewards System
-- Date: 2025-09-02
-- Description: Simple rewards system with 1% monthly rewards, points-based system

-- Drop existing constraints and tables if they exist (for clean migration)
DO $$ 
BEGIN
    -- Drop constraint if it exists
    IF EXISTS (SELECT 1 FROM information_schema.table_constraints 
               WHERE constraint_name = 'single_config' 
               AND table_name = 'rewards_config') THEN
        ALTER TABLE rewards_config DROP CONSTRAINT single_config;
    END IF;
    
    -- Drop tables if they exist
    DROP TABLE IF EXISTS rewards_calculations CASCADE;
    DROP TABLE IF EXISTS rewards_transactions CASCADE;
    DROP TABLE IF EXISTS rewards_balances CASCADE;
    DROP TABLE IF EXISTS rewards_config CASCADE;
    
    -- Drop any leftover indexes
    DROP INDEX IF EXISTS rewards_config_single_row;
END $$;

-- Rewards configuration table (for system settings)
CREATE TABLE rewards_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Configuration settings
    rewards_rate DECIMAL(5,4) NOT NULL DEFAULT 0.0100, -- 1% = 0.0100
    minimum_transaction_amount DECIMAL(18,6) DEFAULT 0.000000, -- Minimum transaction to earn rewards
    rewards_enabled BOOLEAN DEFAULT TRUE,
    calculation_period VARCHAR(20) DEFAULT 'monthly' CHECK (calculation_period IN ('monthly', 'weekly', 'daily')),
    
    -- Metadata
    description TEXT DEFAULT 'Simple 1% monthly rewards on all transactions',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User rewards balances (separate from main wallet)
CREATE TABLE rewards_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Rewards balance (in Freti equivalent, but displayed as ⭐ points)
    available_rewards DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    pending_rewards DECIMAL(18,6) NOT NULL DEFAULT 0.000000, -- Rewards earned but not yet credited
    lifetime_earned DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    lifetime_spent DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    
    -- Last calculation period
    last_calculation_period VARCHAR(7), -- Format: 2025-08 (year-month)
    last_calculated_at TIMESTAMP WITH TIME ZONE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(user_id)
);

-- Rewards transactions (ledger for all rewards activity)
CREATE TABLE rewards_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Transaction details
    transaction_type VARCHAR(50) NOT NULL CHECK (transaction_type IN (
        'monthly_credit',       -- Monthly rewards credited
        'purchase_redemption',  -- Rewards spent on purchases
        'refund_reversal',     -- Rewards returned from cancelled transactions
        'admin_adjustment',     -- Manual adjustment
        'expired_deduction'     -- Rewards expired (future feature)
    )),
    
    -- Amounts
    available_delta DECIMAL(18,6) NOT NULL DEFAULT 0.000000, -- Change in available rewards
    pending_delta DECIMAL(18,6) NOT NULL DEFAULT 0.000000,   -- Change in pending rewards
    
    -- Balances after transaction (for audit)
    available_balance_after DECIMAL(18,6) NOT NULL,
    pending_balance_after DECIMAL(18,6) NOT NULL,
    
    -- Reference data
    calculation_period VARCHAR(7), -- For monthly_credit: 2025-08
    reference_type VARCHAR(50),    -- 'order', 'calculation', 'refund'
    reference_id UUID,             -- ID of related record
    
    -- Metadata
    description TEXT,
    metadata JSONB DEFAULT '{}',
    created_by UUID REFERENCES user_profiles(id), -- System or admin user
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Monthly rewards calculations (audit trail)
CREATE TABLE rewards_calculations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Calculation period
    calculation_period VARCHAR(7) NOT NULL, -- Format: 2025-08
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    
    -- Transaction data for this period
    total_transaction_amount DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    qualifying_transaction_amount DECIMAL(18,6) NOT NULL DEFAULT 0.000000, -- After minimums
    transaction_count INTEGER NOT NULL DEFAULT 0,
    
    -- Rewards calculation
    rewards_rate_used DECIMAL(5,4) NOT NULL,
    calculated_rewards DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    credited_rewards DECIMAL(18,6) NOT NULL DEFAULT 0.000000, -- May differ due to caps
    
    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'calculated', 'credited', 'failed'
    )),
    
    -- Processing details
    processed_at TIMESTAMP WITH TIME ZONE,
    failure_reason TEXT,
    
    -- Metadata
    calculation_details JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(user_id, calculation_period)
);

-- Update wallet_ledger to include rewards transactions
ALTER TABLE wallet_ledger 
ADD COLUMN IF NOT EXISTS rewards_used DECIMAL(18,6) DEFAULT 0.000000;

-- Add rewards tracking to transactions that can earn rewards
COMMENT ON COLUMN wallet_ledger.rewards_used IS 'Amount of rewards points used in this transaction';

-- Indexes for performance
CREATE INDEX idx_rewards_balances_user_id ON rewards_balances(user_id);
CREATE INDEX idx_rewards_transactions_user_id ON rewards_transactions(user_id);
CREATE INDEX idx_rewards_transactions_type ON rewards_transactions(transaction_type);
CREATE INDEX idx_rewards_transactions_created_at ON rewards_transactions(created_at DESC);
CREATE INDEX idx_rewards_transactions_reference ON rewards_transactions(reference_type, reference_id);
CREATE INDEX idx_rewards_calculations_user_id ON rewards_calculations(user_id);
CREATE INDEX idx_rewards_calculations_period ON rewards_calculations(calculation_period);
CREATE INDEX idx_rewards_calculations_status ON rewards_calculations(status);

-- Function to update rewards balances
CREATE OR REPLACE FUNCTION update_rewards_balances()
RETURNS TRIGGER AS $$
BEGIN
    -- Update rewards balance based on transaction
    UPDATE rewards_balances 
    SET 
        available_rewards = available_rewards + NEW.available_delta,
        pending_rewards = pending_rewards + NEW.pending_delta,
        lifetime_earned = lifetime_earned + GREATEST(NEW.available_delta + NEW.pending_delta, 0),
        lifetime_spent = lifetime_spent + GREATEST(-(NEW.available_delta + NEW.pending_delta), 0),
        updated_at = NOW()
    WHERE user_id = NEW.user_id;
    
    -- Verify rewards balance is non-negative
    IF EXISTS (
        SELECT 1 FROM rewards_balances 
        WHERE user_id = NEW.user_id 
        AND (available_rewards < 0 OR pending_rewards < 0)
    ) THEN
        RAISE EXCEPTION 'Rewards balance cannot be negative';
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update rewards balances
CREATE TRIGGER update_rewards_balances_trigger
    AFTER INSERT ON rewards_transactions
    FOR EACH ROW EXECUTE FUNCTION update_rewards_balances();

-- Function to create rewards balance for new users
CREATE OR REPLACE FUNCTION create_user_rewards_balance()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO rewards_balances (user_id) VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to create rewards balance for new users
CREATE TRIGGER create_user_rewards_balance_trigger
    AFTER INSERT ON user_profiles
    FOR EACH ROW EXECUTE FUNCTION create_user_rewards_balance();

-- Update trigger for timestamps
CREATE TRIGGER update_rewards_balances_updated_at 
    BEFORE UPDATE ON rewards_balances 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_rewards_calculations_updated_at 
    BEFORE UPDATE ON rewards_calculations 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add constraint to ensure only one config row (using a unique partial index)
CREATE UNIQUE INDEX rewards_config_single_row ON rewards_config ((1));

-- Insert default configuration
INSERT INTO rewards_config (
    rewards_rate,
    minimum_transaction_amount,
    rewards_enabled,
    description
) VALUES (
    0.0100, -- 1%
    0.000000, -- No minimum
    TRUE,
    'Earn 1% rewards on all monthly transactions'
);

-- Initialize rewards balances for existing users
INSERT INTO rewards_balances (user_id)
SELECT id FROM user_profiles
ON CONFLICT (user_id) DO NOTHING;

-- View for easy rewards data access
CREATE OR REPLACE VIEW user_rewards_summary AS
SELECT 
    rb.user_id,
    rb.available_rewards,
    rb.pending_rewards,
    rb.lifetime_earned,
    rb.lifetime_spent,
    rb.last_calculation_period,
    rb.last_calculated_at,
    COALESCE(rc_current.total_transaction_amount, 0) as current_month_transactions,
    COALESCE(rc_current.calculated_rewards, 0) as current_month_rewards,
    rc.rewards_rate,
    rc.rewards_enabled
FROM rewards_balances rb
CROSS JOIN rewards_config rc
LEFT JOIN rewards_calculations rc_current ON (
    rc_current.user_id = rb.user_id 
    AND rc_current.calculation_period = TO_CHAR(CURRENT_DATE, 'YYYY-MM')
    AND rc_current.status = 'calculated'
);

-- Grant permissions
GRANT SELECT ON rewards_config TO authenticated;
GRANT SELECT, UPDATE ON rewards_balances TO authenticated;
GRANT SELECT ON rewards_transactions TO authenticated;
GRANT SELECT ON rewards_calculations TO authenticated;
GRANT SELECT ON user_rewards_summary TO authenticated;

-- Service role needs full access for system operations
GRANT ALL ON rewards_config TO service_role;
GRANT ALL ON rewards_balances TO service_role;
GRANT ALL ON rewards_transactions TO service_role;
GRANT ALL ON rewards_calculations TO service_role;

COMMIT;