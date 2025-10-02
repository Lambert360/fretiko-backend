-- Migration: Add Row Level Security to Wallet System
-- Date: 2025-08-28
-- Description: Enable RLS and create security policies for all wallet tables

BEGIN;

-- Enable RLS on all wallet tables
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE escrows ENABLE ROW LEVEL SECURITY;
ALTER TABLE payout_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE trust_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_flags ENABLE ROW LEVEL SECURITY;

-- ================================
-- WALLETS RLS POLICIES
-- ================================

-- Users can only see their own wallet
CREATE POLICY wallet_select_own ON wallets 
FOR SELECT TO authenticated 
USING (user_id = auth.uid());

-- Users can only update their own wallet (system updates via service_role)
CREATE POLICY wallet_update_own ON wallets 
FOR UPDATE TO authenticated 
USING (user_id = auth.uid());

-- Service role can do everything for system operations
CREATE POLICY wallet_service_all ON wallets 
FOR ALL TO service_role 
USING (true);

-- ================================
-- WALLET LEDGER RLS POLICIES
-- ================================

-- Users can only see their own transaction history
CREATE POLICY wallet_ledger_select_own ON wallet_ledger 
FOR SELECT TO authenticated 
USING (user_id = auth.uid());

-- Only service_role can insert ledger entries (immutable audit trail)
CREATE POLICY wallet_ledger_service_insert ON wallet_ledger 
FOR INSERT TO service_role 
WITH CHECK (true);

-- Service role can do everything
CREATE POLICY wallet_ledger_service_all ON wallet_ledger 
FOR ALL TO service_role 
USING (true);

-- ================================
-- ORDERS RLS POLICIES
-- ================================

-- Users can see orders they're involved in (buyer, vendor, or rider)
CREATE POLICY orders_select_participant ON orders 
FOR SELECT TO authenticated 
USING (
    buyer_id = auth.uid() OR 
    vendor_id = auth.uid() OR 
    rider_id = auth.uid()
);

-- Users can insert orders as buyers
CREATE POLICY orders_insert_buyer ON orders 
FOR INSERT TO authenticated 
WITH CHECK (buyer_id = auth.uid());

-- Users can update orders they're involved in (with restrictions)
CREATE POLICY orders_update_participant ON orders 
FOR UPDATE TO authenticated 
USING (
    buyer_id = auth.uid() OR 
    vendor_id = auth.uid() OR 
    rider_id = auth.uid()
);

-- Service role can do everything
CREATE POLICY orders_service_all ON orders 
FOR ALL TO service_role 
USING (true);

-- ================================
-- ORDER ITEMS RLS POLICIES
-- ================================

-- Users can see order items for orders they're involved in
CREATE POLICY order_items_select_participant ON order_items 
FOR SELECT TO authenticated 
USING (
    EXISTS (
        SELECT 1 FROM orders 
        WHERE orders.id = order_items.order_id 
        AND (
            orders.buyer_id = auth.uid() OR 
            orders.vendor_id = auth.uid() OR 
            orders.rider_id = auth.uid()
        )
    )
);

-- Users can insert order items for their orders
CREATE POLICY order_items_insert_participant ON order_items 
FOR INSERT TO authenticated 
WITH CHECK (
    EXISTS (
        SELECT 1 FROM orders 
        WHERE orders.id = order_items.order_id 
        AND orders.buyer_id = auth.uid()
    )
);

-- Service role can do everything
CREATE POLICY order_items_service_all ON order_items 
FOR ALL TO service_role 
USING (true);

-- ================================
-- ESCROWS RLS POLICIES
-- ================================

-- Users can see escrows for orders they're involved in
CREATE POLICY escrows_select_participant ON escrows 
FOR SELECT TO authenticated 
USING (
    EXISTS (
        SELECT 1 FROM orders 
        WHERE orders.id = escrows.order_id 
        AND (
            orders.buyer_id = auth.uid() OR 
            orders.vendor_id = auth.uid() OR 
            orders.rider_id = auth.uid()
        )
    )
);

-- Only service_role can manage escrows (system operation)
CREATE POLICY escrows_service_all ON escrows 
FOR ALL TO service_role 
USING (true);

-- ================================
-- PAYOUT REQUESTS RLS POLICIES
-- ================================

-- Users can only see their own payout requests
CREATE POLICY payout_requests_select_own ON payout_requests 
FOR SELECT TO authenticated 
USING (user_id = auth.uid());

-- Users can only create their own payout requests
CREATE POLICY payout_requests_insert_own ON payout_requests 
FOR INSERT TO authenticated 
WITH CHECK (user_id = auth.uid());

-- Users can update their own pending payout requests
CREATE POLICY payout_requests_update_own ON payout_requests 
FOR UPDATE TO authenticated 
USING (
    user_id = auth.uid() AND 
    status IN ('requested', 'pending')
);

-- Service role can do everything
CREATE POLICY payout_requests_service_all ON payout_requests 
FOR ALL TO service_role 
USING (true);

-- ================================
-- DEPOSITS RLS POLICIES
-- ================================

-- Users can only see their own deposits
CREATE POLICY deposits_select_own ON deposits 
FOR SELECT TO authenticated 
USING (user_id = auth.uid());

-- Users can only create their own deposits
CREATE POLICY deposits_insert_own ON deposits 
FOR INSERT TO authenticated 
WITH CHECK (user_id = auth.uid());

-- Only service_role can update deposits (webhook processing)
CREATE POLICY deposits_service_all ON deposits 
FOR ALL TO service_role 
USING (true);

-- ================================
-- TRUST SCORES RLS POLICIES
-- ================================

-- Users can see trust scores for users they interact with
CREATE POLICY trust_scores_select_visible ON trust_scores 
FOR SELECT TO authenticated 
USING (
    -- Own trust score
    user_id = auth.uid() OR 
    -- Trust scores for users in shared orders
    EXISTS (
        SELECT 1 FROM orders 
        WHERE (
            (orders.buyer_id = auth.uid() AND orders.vendor_id = trust_scores.user_id) OR
            (orders.buyer_id = auth.uid() AND orders.rider_id = trust_scores.user_id) OR
            (orders.vendor_id = auth.uid() AND orders.buyer_id = trust_scores.user_id) OR
            (orders.vendor_id = auth.uid() AND orders.rider_id = trust_scores.user_id) OR
            (orders.rider_id = auth.uid() AND orders.buyer_id = trust_scores.user_id) OR
            (orders.rider_id = auth.uid() AND orders.vendor_id = trust_scores.user_id)
        )
    )
);

-- Only service_role can update trust scores
CREATE POLICY trust_scores_service_all ON trust_scores 
FOR ALL TO service_role 
USING (true);

-- ================================
-- RISK FLAGS RLS POLICIES
-- ================================

-- Users can only see their own risk flags
CREATE POLICY risk_flags_select_own ON risk_flags 
FOR SELECT TO authenticated 
USING (user_id = auth.uid());

-- Only service_role can manage risk flags
CREATE POLICY risk_flags_service_all ON risk_flags 
FOR ALL TO service_role 
USING (true);

-- ================================
-- HELPER FUNCTIONS FOR RLS
-- ================================

-- Function to check if user is involved in an order
CREATE OR REPLACE FUNCTION is_order_participant(order_id UUID, user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM orders 
        WHERE id = order_id 
        AND (
            buyer_id = user_id OR 
            vendor_id = user_id OR 
            rider_id = user_id
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if user can see another user's trust score
CREATE OR REPLACE FUNCTION can_see_trust_score(target_user_id UUID, requesting_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    -- Can always see own trust score
    IF target_user_id = requesting_user_id THEN
        RETURN TRUE;
    END IF;
    
    -- Can see trust scores for users you've interacted with
    RETURN EXISTS (
        SELECT 1 FROM orders 
        WHERE (
            (buyer_id = requesting_user_id AND (vendor_id = target_user_id OR rider_id = target_user_id)) OR
            (vendor_id = requesting_user_id AND (buyer_id = target_user_id OR rider_id = target_user_id)) OR
            (rider_id = requesting_user_id AND (buyer_id = target_user_id OR vendor_id = target_user_id))
        )
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ================================
-- ADDITIONAL SECURITY MEASURES
-- ================================

-- Ensure wallet creation is only done by system
CREATE POLICY wallet_no_user_insert ON wallets 
FOR INSERT TO authenticated 
WITH CHECK (false);

-- Create user wallet summary as a table for better performance and RLS control
CREATE TABLE user_wallet_summary (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Wallet balances
    available_balance DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    escrow_balance DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    pending_withdrawal DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    total_balance DECIMAL(18,6) GENERATED ALWAYS AS (available_balance + escrow_balance) STORED,
    
    -- Currency and KYC
    preferred_currency VARCHAR(3) DEFAULT 'USD',
    kyc_status VARCHAR(20) DEFAULT 'pending',
    daily_deposit_limit DECIMAL(18,6) DEFAULT 10000.000000,
    daily_withdrawal_limit DECIMAL(18,6) DEFAULT 5000.000000,
    
    -- Trust scores
    vendor_trust_score INTEGER DEFAULT 0,
    rider_trust_score INTEGER DEFAULT 0,
    buyer_trust_score INTEGER DEFAULT 0,
    
    -- Activity metrics
    total_orders INTEGER DEFAULT 0,
    completed_orders INTEGER DEFAULT 0,
    active_risk_flags INTEGER DEFAULT 0,
    
    -- Local currency equivalent (cached for performance)
    local_currency_equivalent JSONB DEFAULT '{}',
    
    -- Recent activity counts
    recent_transaction_count INTEGER DEFAULT 0,
    monthly_deposits DECIMAL(18,6) DEFAULT 0.000000,
    monthly_spending DECIMAL(18,6) DEFAULT 0.000000,
    
    -- Timestamps
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(user_id)
);

-- Enable RLS on user wallet summary
ALTER TABLE user_wallet_summary ENABLE ROW LEVEL SECURITY;

-- Users can only see their own wallet summary
CREATE POLICY user_wallet_summary_select_own ON user_wallet_summary 
FOR SELECT TO authenticated 
USING (user_id = auth.uid());

-- Only service_role can manage wallet summaries
CREATE POLICY user_wallet_summary_service_all ON user_wallet_summary 
FOR ALL TO service_role 
USING (true);

-- Grant permissions
GRANT SELECT ON user_wallet_summary TO authenticated;
GRANT ALL ON user_wallet_summary TO service_role;

-- Create indexes for performance
CREATE INDEX idx_user_wallet_summary_user_id ON user_wallet_summary(user_id);
CREATE INDEX idx_user_wallet_summary_updated ON user_wallet_summary(last_updated_at);

-- Function to refresh wallet summary for a user
CREATE OR REPLACE FUNCTION refresh_user_wallet_summary(target_user_id UUID)
RETURNS VOID AS $$
DECLARE
    wallet_data RECORD;
    trust_data RECORD;
    activity_data RECORD;
    risk_count INTEGER;
BEGIN
    -- Get wallet data
    SELECT * INTO wallet_data FROM wallets WHERE user_id = target_user_id;
    
    -- Get trust scores
    SELECT * INTO trust_data FROM trust_scores WHERE user_id = target_user_id;
    
    -- Get activity metrics
    SELECT 
        COUNT(CASE WHEN status IN ('completed', 'delivered') THEN 1 END) as completed_orders,
        COUNT(*) as total_orders
    INTO activity_data
    FROM orders 
    WHERE buyer_id = target_user_id OR vendor_id = target_user_id OR rider_id = target_user_id;
    
    -- Get risk flags count
    SELECT COUNT(*) INTO risk_count 
    FROM risk_flags 
    WHERE user_id = target_user_id AND is_active = true;
    
    -- Get recent transaction count and monthly totals
    WITH recent_stats AS (
        SELECT 
            COUNT(*) as transaction_count,
            COALESCE(SUM(CASE WHEN transaction_type = 'deposit_mint' AND created_at >= date_trunc('month', now()) THEN available_delta ELSE 0 END), 0) as monthly_deposits,
            COALESCE(SUM(CASE WHEN transaction_type = 'purchase_hold' AND created_at >= date_trunc('month', now()) THEN ABS(available_delta) ELSE 0 END), 0) as monthly_spending
        FROM wallet_ledger 
        WHERE user_id = target_user_id 
        AND created_at >= now() - interval '30 days'
    )
    -- Upsert wallet summary
    INSERT INTO user_wallet_summary (
        user_id,
        available_balance,
        escrow_balance,
        pending_withdrawal,
        preferred_currency,
        kyc_status,
        daily_deposit_limit,
        daily_withdrawal_limit,
        vendor_trust_score,
        rider_trust_score,
        buyer_trust_score,
        total_orders,
        completed_orders,
        active_risk_flags,
        recent_transaction_count,
        monthly_deposits,
        monthly_spending,
        local_currency_equivalent,
        last_updated_at
    )
    SELECT 
        target_user_id,
        COALESCE(wallet_data.available_balance, 0),
        COALESCE(wallet_data.escrow_balance, 0),
        COALESCE(wallet_data.pending_withdrawal, 0),
        COALESCE(wallet_data.preferred_currency, 'USD'),
        COALESCE(wallet_data.kyc_status, 'pending'),
        COALESCE(wallet_data.daily_deposit_limit, 10000),
        COALESCE(wallet_data.daily_withdrawal_limit, 5000),
        COALESCE(trust_data.vendor_trust_score, 0),
        COALESCE(trust_data.rider_trust_score, 0),
        COALESCE(trust_data.buyer_trust_score, 0),
        COALESCE(activity_data.total_orders, 0),
        COALESCE(activity_data.completed_orders, 0),
        COALESCE(risk_count, 0),
        rs.transaction_count,
        rs.monthly_deposits,
        rs.monthly_spending,
        jsonb_build_object(
            'currency', COALESCE(wallet_data.preferred_currency, 'USD'),
            'available', COALESCE(wallet_data.available_balance, 0),
            'total', COALESCE(wallet_data.available_balance, 0) + COALESCE(wallet_data.escrow_balance, 0),
            'escrow', COALESCE(wallet_data.escrow_balance, 0),
            'pending', COALESCE(wallet_data.pending_withdrawal, 0)
        ),
        NOW()
    FROM recent_stats rs
    ON CONFLICT (user_id) DO UPDATE SET
        available_balance = EXCLUDED.available_balance,
        escrow_balance = EXCLUDED.escrow_balance,
        pending_withdrawal = EXCLUDED.pending_withdrawal,
        preferred_currency = EXCLUDED.preferred_currency,
        kyc_status = EXCLUDED.kyc_status,
        daily_deposit_limit = EXCLUDED.daily_deposit_limit,
        daily_withdrawal_limit = EXCLUDED.daily_withdrawal_limit,
        vendor_trust_score = EXCLUDED.vendor_trust_score,
        rider_trust_score = EXCLUDED.rider_trust_score,
        buyer_trust_score = EXCLUDED.buyer_trust_score,
        total_orders = EXCLUDED.total_orders,
        completed_orders = EXCLUDED.completed_orders,
        active_risk_flags = EXCLUDED.active_risk_flags,
        recent_transaction_count = EXCLUDED.recent_transaction_count,
        monthly_deposits = EXCLUDED.monthly_deposits,
        monthly_spending = EXCLUDED.monthly_spending,
        local_currency_equivalent = EXCLUDED.local_currency_equivalent,
        last_updated_at = NOW(),
        updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to refresh all wallet summaries (for batch processing)
CREATE OR REPLACE FUNCTION refresh_all_wallet_summaries()
RETURNS VOID AS $$
DECLARE
    user_record RECORD;
BEGIN
    FOR user_record IN SELECT id FROM user_profiles
    LOOP
        PERFORM refresh_user_wallet_summary(user_record.id);
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to auto-refresh wallet summary when wallet changes
CREATE OR REPLACE FUNCTION trigger_refresh_wallet_summary()
RETURNS TRIGGER AS $$
BEGIN
    -- Refresh for the affected user
    PERFORM refresh_user_wallet_summary(
        CASE 
            WHEN TG_TABLE_NAME = 'wallets' THEN NEW.user_id
            WHEN TG_TABLE_NAME = 'wallet_ledger' THEN NEW.user_id
            WHEN TG_TABLE_NAME = 'trust_scores' THEN NEW.user_id
            WHEN TG_TABLE_NAME = 'risk_flags' THEN NEW.user_id
            WHEN TG_TABLE_NAME = 'orders' THEN NEW.buyer_id
            ELSE NULL
        END
    );
    
    -- If it's an order, also refresh vendor and rider
    IF TG_TABLE_NAME = 'orders' THEN
        PERFORM refresh_user_wallet_summary(NEW.vendor_id);
        IF NEW.rider_id IS NOT NULL THEN
            PERFORM refresh_user_wallet_summary(NEW.rider_id);
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create triggers to keep wallet summary in sync
CREATE TRIGGER refresh_wallet_summary_on_wallet_change
    AFTER UPDATE ON wallets
    FOR EACH ROW EXECUTE FUNCTION trigger_refresh_wallet_summary();

CREATE TRIGGER refresh_wallet_summary_on_ledger_insert
    AFTER INSERT ON wallet_ledger
    FOR EACH ROW EXECUTE FUNCTION trigger_refresh_wallet_summary();

CREATE TRIGGER refresh_wallet_summary_on_trust_change
    AFTER UPDATE ON trust_scores
    FOR EACH ROW EXECUTE FUNCTION trigger_refresh_wallet_summary();

CREATE TRIGGER refresh_wallet_summary_on_risk_change
    AFTER INSERT OR UPDATE ON risk_flags
    FOR EACH ROW EXECUTE FUNCTION trigger_refresh_wallet_summary();

CREATE TRIGGER refresh_wallet_summary_on_order_change
    AFTER INSERT OR UPDATE ON orders
    FOR EACH ROW EXECUTE FUNCTION trigger_refresh_wallet_summary();

-- Add update trigger for wallet summary
CREATE TRIGGER update_user_wallet_summary_updated_at 
    BEFORE UPDATE ON user_wallet_summary 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Initialize wallet summaries for existing users
SELECT refresh_user_wallet_summary(id) FROM user_profiles;

-- ================================
-- AUDIT AND MONITORING
-- ================================

-- Create audit log for sensitive wallet operations
CREATE TABLE IF NOT EXISTS wallet_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    operation VARCHAR(50) NOT NULL,
    table_name VARCHAR(50) NOT NULL,
    record_id UUID,
    old_values JSONB,
    new_values JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS on audit log
ALTER TABLE wallet_audit_log ENABLE ROW LEVEL SECURITY;

-- Only service_role can insert audit logs
CREATE POLICY wallet_audit_service_insert ON wallet_audit_log 
FOR INSERT TO service_role 
WITH CHECK (true);

-- Users can see their own audit logs
CREATE POLICY wallet_audit_select_own ON wallet_audit_log 
FOR SELECT TO authenticated 
USING (user_id = auth.uid());

-- Service role can see all audit logs
CREATE POLICY wallet_audit_service_all ON wallet_audit_log 
FOR ALL TO service_role 
USING (true);

-- Grant permissions
GRANT SELECT ON wallet_audit_log TO authenticated;
GRANT ALL ON wallet_audit_log TO service_role;

COMMIT;