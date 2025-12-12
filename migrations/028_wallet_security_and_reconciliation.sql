-- Migration: Wallet System Security, Concurrency Fixes, and Reconciliation
-- Date: 2025-01-XX
-- Description: Combined migration for wallet concurrency fixes, reconciliation alerts table, and balance reconciliation functions
--
-- This migration includes:
-- 1. Database-level concurrency control (row-level locking)
-- 2. Atomic wallet operations with idempotency checks
-- 3. Daily limit validation in transactions
-- 4. Balance calculation triggers
-- 5. Reconciliation alerts table and infrastructure
-- 6. Balance reconciliation helper functions

BEGIN;

-- ================================
-- PART 1: Update trigger to calculate available_balance_after
-- ================================

-- BEFORE trigger to calculate balance_after values
CREATE OR REPLACE FUNCTION calculate_wallet_balance_after()
RETURNS TRIGGER AS $$
DECLARE
    current_available DECIMAL(18,6);
    current_escrow DECIMAL(18,6);
    current_pending DECIMAL(18,6);
BEGIN
    -- Lock the wallet row to prevent concurrent modifications
    SELECT available_balance, escrow_balance, pending_withdrawal
    INTO current_available, current_escrow, current_pending
    FROM wallets
    WHERE id = NEW.wallet_id
    FOR UPDATE;
    
    -- Calculate new balances and set in NEW record
    NEW.available_balance_after := current_available + NEW.available_delta;
    NEW.escrow_balance_after := current_escrow + NEW.escrow_delta;
    NEW.pending_withdrawal_after := current_pending + NEW.pending_withdrawal_delta;
    
    -- Verify balances are non-negative (safety check)
    IF NEW.available_balance_after < 0 OR NEW.escrow_balance_after < 0 OR NEW.pending_withdrawal_after < 0 THEN
        RAISE EXCEPTION 'Wallet balance cannot be negative. Available: %, Escrow: %, Pending: %',
            NEW.available_balance_after, NEW.escrow_balance_after, NEW.pending_withdrawal_after;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- AFTER trigger to update wallet balances
CREATE OR REPLACE FUNCTION update_wallet_balances()
RETURNS TRIGGER AS $$
BEGIN
    -- Update wallet balances based on calculated values from ledger entry
    UPDATE wallets 
    SET 
        available_balance = NEW.available_balance_after,
        escrow_balance = NEW.escrow_balance_after,
        pending_withdrawal = NEW.pending_withdrawal_after,
        updated_at = NOW()
    WHERE id = NEW.wallet_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS calculate_wallet_balance_after_trigger ON wallet_ledger;
DROP TRIGGER IF EXISTS update_wallet_balances_trigger ON wallet_ledger;

-- Create BEFORE trigger for balance calculation
CREATE TRIGGER calculate_wallet_balance_after_trigger
    BEFORE INSERT ON wallet_ledger
    FOR EACH ROW EXECUTE FUNCTION calculate_wallet_balance_after();

-- Create AFTER trigger for wallet balance update
CREATE TRIGGER update_wallet_balances_trigger
    AFTER INSERT ON wallet_ledger
    FOR EACH ROW EXECUTE FUNCTION update_wallet_balances();

-- ================================
-- PART 2: Atomic wallet operation function with locking
-- ================================

CREATE OR REPLACE FUNCTION atomic_wallet_operation(
    p_user_id UUID,
    p_available_delta DECIMAL(18,6),
    p_escrow_delta DECIMAL(18,6),
    p_pending_withdrawal_delta DECIMAL(18,6),
    p_transaction_type VARCHAR(50),
    p_reference_type VARCHAR(50),
    p_reference_id UUID,
    p_idempotency_key VARCHAR(255),
    p_description TEXT,
    p_metadata JSONB DEFAULT '{}'::JSONB,
    p_created_by UUID DEFAULT NULL
)
RETURNS TABLE(
    success BOOLEAN,
    wallet_id UUID,
    available_balance_after DECIMAL(18,6),
    escrow_balance_after DECIMAL(18,6),
    pending_withdrawal_after DECIMAL(18,6),
    ledger_entry_id UUID,
    error_message TEXT
) AS $$
DECLARE
    v_wallet_id UUID;
    v_current_available DECIMAL(18,6);
    v_current_escrow DECIMAL(18,6);
    v_current_pending DECIMAL(18,6);
    v_new_available DECIMAL(18,6);
    v_new_escrow DECIMAL(18,6);
    v_new_pending DECIMAL(18,6);
    v_ledger_id UUID;
    v_idempotency_exists BOOLEAN;
BEGIN
    -- Check idempotency key first (before any balance operations)
    SELECT EXISTS(
        SELECT 1 FROM wallet_ledger 
        WHERE idempotency_key = p_idempotency_key
    ) INTO v_idempotency_exists;
    
    IF v_idempotency_exists THEN
        -- Return existing ledger entry
        SELECT 
            wallet_id,
            available_balance_after,
            escrow_balance_after,
            pending_withdrawal_after,
            id
        INTO v_wallet_id, v_new_available, v_new_escrow, v_new_pending, v_ledger_id
        FROM wallet_ledger
        WHERE idempotency_key = p_idempotency_key
        LIMIT 1;
        
        RETURN QUERY SELECT 
            TRUE as success,
            v_wallet_id,
            v_new_available,
            v_new_escrow,
            v_new_pending,
            v_ledger_id,
            NULL::TEXT as error_message;
        RETURN;
    END IF;
    
    -- Get wallet with row-level lock (FOR UPDATE prevents concurrent modifications)
    SELECT id, available_balance, escrow_balance, pending_withdrawal
    INTO v_wallet_id, v_current_available, v_current_escrow, v_current_pending
    FROM wallets
    WHERE user_id = p_user_id
    FOR UPDATE;
    
    IF v_wallet_id IS NULL THEN
        RETURN QUERY SELECT 
            FALSE as success,
            NULL::UUID as wallet_id,
            NULL::DECIMAL as available_balance_after,
            NULL::DECIMAL as escrow_balance_after,
            NULL::DECIMAL as pending_withdrawal_after,
            NULL::UUID as ledger_entry_id,
            'Wallet not found'::TEXT as error_message;
        RETURN;
    END IF;
    
    -- Calculate new balances
    v_new_available := v_current_available + p_available_delta;
    v_new_escrow := v_current_escrow + p_escrow_delta;
    v_new_pending := v_current_pending + p_pending_withdrawal_delta;
    
    -- Validate balances are non-negative
    IF v_new_available < 0 OR v_new_escrow < 0 OR v_new_pending < 0 THEN
        RETURN QUERY SELECT 
            FALSE as success,
            v_wallet_id,
            NULL::DECIMAL as available_balance_after,
            NULL::DECIMAL as escrow_balance_after,
            NULL::DECIMAL as pending_withdrawal_after,
            NULL::UUID as ledger_entry_id,
            format('Insufficient balance. Available: %, Required: %', 
                v_current_available, ABS(p_available_delta))::TEXT as error_message;
        RETURN;
    END IF;
    
    -- Generate ledger entry ID
    v_ledger_id := gen_random_uuid();
    
    -- Insert ledger entry (trigger will update wallet balances)
    INSERT INTO wallet_ledger (
        id,
        wallet_id,
        user_id,
        transaction_type,
        available_delta,
        escrow_delta,
        pending_withdrawal_delta,
        available_balance_after,
        escrow_balance_after,
        pending_withdrawal_after,
        reference_type,
        reference_id,
        idempotency_key,
        description,
        metadata,
        created_by
    ) VALUES (
        v_ledger_id,
        v_wallet_id,
        p_user_id,
        p_transaction_type,
        p_available_delta,
        p_escrow_delta,
        p_pending_withdrawal_delta,
        v_new_available,  -- Calculated balance
        v_new_escrow,     -- Calculated balance
        v_new_pending,    -- Calculated balance
        p_reference_type,
        p_reference_id,
        p_idempotency_key,
        p_description,
        p_metadata,
        p_created_by
    );
    
    -- Update wallet balances (redundant with trigger, but ensures consistency)
    UPDATE wallets 
    SET 
        available_balance = v_new_available,
        escrow_balance = v_new_escrow,
        pending_withdrawal = v_new_pending,
        updated_at = NOW()
    WHERE id = v_wallet_id;
    
    RETURN QUERY SELECT 
        TRUE as success,
        v_wallet_id,
        v_new_available,
        v_new_escrow,
        v_new_pending,
        v_ledger_id,
        NULL::TEXT as error_message;
END;
$$ LANGUAGE plpgsql;

-- ================================
-- PART 3: Atomic daily limit validation function
-- ================================

CREATE OR REPLACE FUNCTION validate_daily_limit(
    p_user_id UUID,
    p_amount DECIMAL(18,6),
    p_limit_type VARCHAR(20), -- 'deposit' or 'withdrawal'
    p_transaction_type VARCHAR(50) -- 'deposit_mint' or 'withdrawal_burn'
)
RETURNS TABLE(
    is_valid BOOLEAN,
    daily_limit DECIMAL(18,6),
    daily_used DECIMAL(18,6),
    remaining DECIMAL(18,6),
    error_message TEXT
) AS $$
DECLARE
    v_wallet_limit DECIMAL(18,6);
    v_daily_used DECIMAL(18,6);
    v_today_start TIMESTAMP WITH TIME ZONE;
    v_today_end TIMESTAMP WITH TIME ZONE;
BEGIN
    -- Set today's time bounds (UTC)
    v_today_start := date_trunc('day', NOW())::TIMESTAMP WITH TIME ZONE;
    v_today_end := v_today_start + INTERVAL '1 day';
    
    -- Get wallet limit based on type
    IF p_limit_type = 'deposit' THEN
        SELECT daily_deposit_limit INTO v_wallet_limit
        FROM wallets
        WHERE user_id = p_user_id;
        
        -- Calculate daily deposits (must be in same transaction for atomicity)
        SELECT COALESCE(SUM(available_delta), 0)
        INTO v_daily_used
        FROM wallet_ledger
        WHERE user_id = p_user_id
        AND transaction_type = 'deposit_mint'
        AND created_at >= v_today_start
        AND created_at < v_today_end;
        
    ELSIF p_limit_type = 'withdrawal' THEN
        SELECT daily_withdrawal_limit INTO v_wallet_limit
        FROM wallets
        WHERE user_id = p_user_id;
        
        -- Calculate daily withdrawals from payout requests
        SELECT COALESCE(SUM(freti_amount), 0)
        INTO v_daily_used
        FROM payout_requests
        WHERE user_id = p_user_id
        AND status IN ('requested', 'pending', 'processing', 'paid')
        AND requested_at >= v_today_start
        AND requested_at < v_today_end;
        
    ELSE
        RETURN QUERY SELECT 
            FALSE as is_valid,
            NULL::DECIMAL as daily_limit,
            NULL::DECIMAL as daily_used,
            NULL::DECIMAL as remaining,
            format('Invalid limit type: %', p_limit_type)::TEXT as error_message;
        RETURN;
    END IF;
    
    -- Validate
    IF v_wallet_limit IS NULL THEN
        RETURN QUERY SELECT 
            FALSE as is_valid,
            NULL::DECIMAL as daily_limit,
            NULL::DECIMAL as daily_used,
            NULL::DECIMAL as remaining,
            'Wallet not found'::TEXT as error_message;
        RETURN;
    END IF;
    
    IF v_daily_used + p_amount > v_wallet_limit THEN
        RETURN QUERY SELECT 
            FALSE as is_valid,
            v_wallet_limit as daily_limit,
            v_daily_used as daily_used,
            GREATEST(0, v_wallet_limit - v_daily_used) as remaining,
            format('Daily % limit exceeded. Limit: %, Used: %, Requested: %, Remaining: %',
                p_limit_type, v_wallet_limit, v_daily_used, p_amount,
                GREATEST(0, v_wallet_limit - v_daily_used))::TEXT as error_message;
        RETURN;
    END IF;
    
    RETURN QUERY SELECT 
        TRUE as is_valid,
        v_wallet_limit as daily_limit,
        v_daily_used as daily_used,
        v_wallet_limit - v_daily_used as remaining,
        NULL::TEXT as error_message;
END;
$$ LANGUAGE plpgsql;

-- ================================
-- PART 4: Get wallet with lock (helper function)
-- ================================

CREATE OR REPLACE FUNCTION get_wallet_with_lock(p_user_id UUID)
RETURNS TABLE(
    wallet_id UUID,
    user_id UUID,
    available_balance DECIMAL(18,6),
    escrow_balance DECIMAL(18,6),
    pending_withdrawal DECIMAL(18,6),
    daily_deposit_limit DECIMAL(18,6),
    daily_withdrawal_limit DECIMAL(18,6),
    kyc_status VARCHAR(20)
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        w.id,
        w.user_id,
        w.available_balance,
        w.escrow_balance,
        w.pending_withdrawal,
        w.daily_deposit_limit,
        w.daily_withdrawal_limit,
        w.kyc_status
    FROM wallets w
    WHERE w.user_id = p_user_id
    FOR UPDATE;
END;
$$ LANGUAGE plpgsql;

-- ================================
-- PART 5: Helper function for balance calculation from ledger (for reconciliation)
-- ================================

CREATE OR REPLACE FUNCTION calculate_wallet_balances_from_ledger(p_wallet_id UUID)
RETURNS TABLE(
    available_balance DECIMAL(18,6),
    escrow_balance DECIMAL(18,6),
    pending_withdrawal DECIMAL(18,6)
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COALESCE(SUM(available_delta), 0)::DECIMAL(18,6) as available_balance,
        COALESCE(SUM(escrow_delta), 0)::DECIMAL(18,6) as escrow_balance,
        COALESCE(SUM(pending_withdrawal_delta), 0)::DECIMAL(18,6) as pending_withdrawal
    FROM wallet_ledger
    WHERE wallet_id = p_wallet_id;
END;
$$ LANGUAGE plpgsql;

-- ================================
-- PART 6: Create/Update Reconciliation Alerts Table
-- ================================
-- 
-- This table tracks:
-- 1. Exchange rate discrepancies when fallback rates are used
-- 2. Balance reconciliation alerts from periodic checks
-- 3. Balance correction records from auto-correction
--
-- Supports both deposits and withdrawals/payouts

-- Create reconciliation_alerts table if it doesn't exist (matches migration 120 structure)
CREATE TABLE IF NOT EXISTS reconciliation_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Related deposit information (original structure from migration 120)
    deposit_id UUID REFERENCES deposits(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Exchange rate information
    local_amount DECIMAL(18,6) NOT NULL,
    local_currency VARCHAR(10) NOT NULL,
    fallback_rate_used DECIMAL(18,6) NOT NULL,
    estimated_freti_amount DECIMAL(18,6) NOT NULL,
    actual_freti_amount DECIMAL(18,6),
    actual_rate DECIMAL(18,6),
    
    -- Discrepancy calculation
    amount_discrepancy DECIMAL(18,6),
    discrepancy_percentage DECIMAL(10,4),
    
    -- Alert details
    alert_type VARCHAR(50) NOT NULL DEFAULT 'exchange_rate_fallback',
    alert_severity VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (alert_severity IN ('low', 'medium', 'high', 'critical')),
    alert_reason TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'resolved', 'dismissed')),
    
    -- Resolution information
    resolved_by UUID REFERENCES user_profiles(id),
    resolved_at TIMESTAMP WITH TIME ZONE,
    resolution_notes TEXT,
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Alter existing table to add payout_id support and update constraints
DO $$
BEGIN
    -- Add payout_id column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'reconciliation_alerts' AND column_name = 'payout_id'
    ) THEN
        ALTER TABLE reconciliation_alerts 
        ADD COLUMN payout_id UUID REFERENCES payout_requests(id) ON DELETE SET NULL;
        
        -- Make deposit_id nullable to support both deposits and payouts
        -- Check if deposit_id is currently NOT NULL
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'reconciliation_alerts' 
            AND column_name = 'deposit_id' 
            AND is_nullable = 'NO'
        ) THEN
            ALTER TABLE reconciliation_alerts 
            ALTER COLUMN deposit_id DROP NOT NULL;
        END IF;
        
        -- Update alert_type constraint to include new types
        ALTER TABLE reconciliation_alerts 
        DROP CONSTRAINT IF EXISTS reconciliation_alerts_alert_type_check;
        
        ALTER TABLE reconciliation_alerts 
        ADD CONSTRAINT reconciliation_alerts_alert_type_check 
        CHECK (alert_type IN (
            'exchange_rate_fallback',
            'exchange_rate_fallback_deposit',
            'exchange_rate_fallback_withdrawal',
            'balance_reconciliation',
            'balance_correction'
        ));
        
        -- Make fallback_rate_used nullable if needed (for balance reconciliation alerts)
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'reconciliation_alerts' 
            AND column_name = 'fallback_rate_used' 
            AND is_nullable = 'NO'
        ) THEN
            ALTER TABLE reconciliation_alerts 
            ALTER COLUMN fallback_rate_used DROP NOT NULL;
        END IF;
        
        -- Make estimated_freti_amount nullable if needed
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'reconciliation_alerts' 
            AND column_name = 'estimated_freti_amount' 
            AND is_nullable = 'NO'
        ) THEN
            ALTER TABLE reconciliation_alerts 
            ALTER COLUMN estimated_freti_amount DROP NOT NULL;
        END IF;
        
        -- Update local_amount precision if needed (allow both DECIMAL(18,6) and DECIMAL(18,2))
        -- We'll keep it as is since both work, but note the difference
        NULL; -- No change needed for local_amount
    END IF;
END $$;

-- ================================
-- PART 7: Indexes for Performance
-- ================================

-- Wallet ledger indexes
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_idempotency_key 
ON wallet_ledger(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_daily_limit 
ON wallet_ledger(user_id, transaction_type, created_at);

CREATE INDEX IF NOT EXISTS idx_payout_requests_daily_limit 
ON payout_requests(user_id, status, requested_at);

-- Reconciliation alerts indexes
CREATE INDEX IF NOT EXISTS idx_reconciliation_alerts_user_id ON reconciliation_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_alerts_deposit_id ON reconciliation_alerts(deposit_id);
CREATE INDEX IF NOT EXISTS idx_reconciliation_alerts_status ON reconciliation_alerts(status);
CREATE INDEX IF NOT EXISTS idx_reconciliation_alerts_severity ON reconciliation_alerts(alert_severity);
CREATE INDEX IF NOT EXISTS idx_reconciliation_alerts_type ON reconciliation_alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_reconciliation_alerts_created_at ON reconciliation_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reconciliation_alerts_pending ON reconciliation_alerts(status, created_at DESC) WHERE status = 'pending';

-- Create payout_id index only if column exists (added in PART 6)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'reconciliation_alerts' AND column_name = 'payout_id'
    ) THEN
        CREATE INDEX IF NOT EXISTS idx_reconciliation_alerts_payout_id ON reconciliation_alerts(payout_id);
    END IF;
END $$;

-- ================================
-- PART 8: Row Level Security (RLS) for Reconciliation Alerts
-- ================================

-- Enable RLS
ALTER TABLE reconciliation_alerts ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (for idempotency)
DROP POLICY IF EXISTS reconciliation_alerts_select_own ON reconciliation_alerts;
DROP POLICY IF EXISTS reconciliation_alerts_service_all ON reconciliation_alerts;
DROP POLICY IF EXISTS "Admins can view all reconciliation alerts" ON reconciliation_alerts;
DROP POLICY IF EXISTS "Service role can insert reconciliation alerts" ON reconciliation_alerts;
DROP POLICY IF EXISTS "Admins can update reconciliation alerts" ON reconciliation_alerts;

-- Simple RLS Policy: Users can only see their own alerts
CREATE POLICY reconciliation_alerts_select_own ON reconciliation_alerts
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- Service role can do everything (for system-generated alerts)
CREATE POLICY reconciliation_alerts_service_all ON reconciliation_alerts
    FOR ALL TO service_role
    USING (true);

-- Admins and staff with view_revenue permission can view all alerts
CREATE POLICY "Admins can view all reconciliation alerts" ON reconciliation_alerts
    FOR SELECT TO authenticated
    USING (
        -- Regular admins via user_profiles (check preferences->>'isAdmin')
        EXISTS (
            SELECT 1 FROM user_profiles
            WHERE id = auth.uid()
            AND preferences->>'isAdmin' = 'true'
        )
        OR
        -- Staff accounts with view_revenue permission (if staff_accounts table exists)
        (
            EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'staff_accounts')
            AND EXISTS (
                SELECT 1 FROM staff_accounts s
                LEFT JOIN departments d ON s.department_id = d.id
                WHERE s.id = auth.uid()
                AND s.is_active = true
                AND (
                    s.role = 'super_admin'
                    OR (d.permissions IS NOT NULL AND d.permissions ? 'view_revenue')
                )
            )
        )
    );

-- Only service role can insert reconciliation alerts (system-generated)
CREATE POLICY "Service role can insert reconciliation alerts" ON reconciliation_alerts
    FOR INSERT TO service_role
    WITH CHECK (auth.role() = 'service_role');

-- Admins and staff can update reconciliation alerts (for resolution)
CREATE POLICY "Admins can update reconciliation alerts" ON reconciliation_alerts
    FOR UPDATE TO authenticated
    USING (
        -- Regular admins via user_profiles (check preferences->>'isAdmin')
        EXISTS (
            SELECT 1 FROM user_profiles
            WHERE id = auth.uid()
            AND preferences->>'isAdmin' = 'true'
        )
        OR
        -- Staff accounts with view_revenue permission (if staff_accounts table exists)
        (
            EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'staff_accounts')
            AND EXISTS (
                SELECT 1 FROM staff_accounts s
                LEFT JOIN departments d ON s.department_id = d.id
                WHERE s.id = auth.uid()
                AND s.is_active = true
                AND (
                    s.role = 'super_admin'
                    OR (d.permissions IS NOT NULL AND d.permissions ? 'view_revenue')
                )
            )
        )
    );

-- ================================
-- PART 9: Permissions
-- ================================

-- Grant permissions
GRANT SELECT, UPDATE ON reconciliation_alerts TO authenticated;
GRANT ALL ON reconciliation_alerts TO service_role;

-- ================================
-- PART 10: Comments and Documentation
-- ================================

COMMENT ON FUNCTION atomic_wallet_operation IS 'Atomically processes wallet transaction with row-level locking and idempotency checking';
COMMENT ON FUNCTION validate_daily_limit IS 'Atomically validates daily deposit/withdrawal limits within transaction context';
COMMENT ON FUNCTION get_wallet_with_lock IS 'Retrieves wallet with row-level lock for concurrent-safe operations';
COMMENT ON FUNCTION calculate_wallet_balances_from_ledger IS 'Calculates wallet balances by summing all ledger entry deltas for a given wallet (used for reconciliation)';

COMMENT ON TABLE reconciliation_alerts IS 'Tracks exchange rate discrepancies and balance reconciliation alerts for audit and finance review. Supports both deposits and withdrawals.';
COMMENT ON COLUMN reconciliation_alerts.alert_type IS 'Type of reconciliation alert: exchange_rate_fallback_deposit, exchange_rate_fallback_withdrawal, balance_reconciliation, balance_correction';
COMMENT ON COLUMN reconciliation_alerts.status IS 'Alert status: pending (new), reviewed (under review), resolved (fixed), dismissed (false alarm)';
COMMENT ON COLUMN reconciliation_alerts.amount_discrepancy IS 'Difference: actual - estimated. Positive = user received less than expected, Negative = user received more than expected';
COMMENT ON COLUMN reconciliation_alerts.alert_severity IS 'Severity based on discrepancy amount: low < 0.01 FRETI, medium 0.01-1 FRETI, high 1-10 FRETI, critical > 10 FRETI';

COMMIT;

