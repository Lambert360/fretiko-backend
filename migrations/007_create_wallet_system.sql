-- Migration: Create Freti Wallet System
-- Date: 2025-08-28
-- Description: Comprehensive wallet system with Freti currency, escrow, and ledger

-- User wallets table - one per user
CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Freti balances (using DECIMAL for precision - 18 digits, 6 decimal places)
    available_balance DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    escrow_balance DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    pending_withdrawal DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    
    -- Local currency preference for display
    preferred_currency VARCHAR(3) DEFAULT 'USD', -- ISO currency codes
    
    -- KYC and limits
    kyc_status VARCHAR(20) DEFAULT 'pending' CHECK (kyc_status IN ('pending', 'approved', 'rejected')),
    daily_deposit_limit DECIMAL(18,6) DEFAULT 10000.000000,
    daily_withdrawal_limit DECIMAL(18,6) DEFAULT 5000.000000,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(user_id)
);

-- Wallet ledger for all transactions (immutable audit trail)
CREATE TABLE wallet_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Transaction details
    transaction_type VARCHAR(50) NOT NULL CHECK (transaction_type IN (
        'deposit_mint', 'withdrawal_burn', 'purchase_hold', 'escrow_release', 
        'escrow_refund', 'admin_adjustment', 'fee_deduction', 'reward_credit'
    )),
    
    -- Amounts (positive = credit, negative = debit)
    available_delta DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    escrow_delta DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    pending_withdrawal_delta DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    
    -- Balances after this transaction (for audit/reconciliation)
    available_balance_after DECIMAL(18,6) NOT NULL,
    escrow_balance_after DECIMAL(18,6) NOT NULL,
    pending_withdrawal_after DECIMAL(18,6) NOT NULL,
    
    -- Reference data
    reference_type VARCHAR(50), -- 'order', 'payout_request', 'deposit', 'adjustment'
    reference_id UUID, -- ID of the related record
    idempotency_key VARCHAR(255) UNIQUE,
    
    -- Metadata
    description TEXT,
    metadata JSONB DEFAULT '{}',
    created_by UUID REFERENCES user_profiles(id),
    
    -- Audit trail
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Orders table for purchases
CREATE TABLE orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number VARCHAR(50) UNIQUE NOT NULL,
    
    -- Participants
    buyer_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    vendor_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    rider_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
    
    -- Order details
    total_amount DECIMAL(18,6) NOT NULL, -- Total in Freti
    delivery_fee DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    platform_fee DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    
    -- Status tracking
    status VARCHAR(20) NOT NULL DEFAULT 'created' CHECK (status IN (
        'created', 'paid', 'assigned', 'in_transit', 'delivered', 'completed', 'cancelled'
    )),
    
    -- Escrow settings
    escrow_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    escrow_bypass_reason TEXT, -- Why escrow was disabled (if disabled)
    
    -- Delivery details
    delivery_address JSONB,
    delivery_instructions TEXT,
    estimated_delivery TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Order items (line items for each order)
CREATE TABLE order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    
    -- Item details
    product_name VARCHAR(255) NOT NULL,
    product_id UUID, -- Reference to products table (if exists)
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price DECIMAL(18,6) NOT NULL,
    total_price DECIMAL(18,6) NOT NULL,
    
    -- Product metadata
    product_metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Escrow records for transaction security
CREATE TABLE escrows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    
    -- Escrow details
    total_amount DECIMAL(18,6) NOT NULL,
    vendor_amount DECIMAL(18,6) NOT NULL, -- Amount for vendor
    rider_amount DECIMAL(18,6) NOT NULL DEFAULT 0.000000, -- Amount for rider
    platform_amount DECIMAL(18,6) NOT NULL DEFAULT 0.000000, -- Platform fees
    
    -- Status tracking
    status VARCHAR(20) NOT NULL DEFAULT 'held' CHECK (status IN (
        'pending', 'held', 'released', 'refunded', 'cancelled', 'dispute'
    )),
    
    -- Timing
    auto_release_at TIMESTAMP WITH TIME ZONE, -- Auto-release if no action
    released_at TIMESTAMP WITH TIME ZONE,
    
    -- Actions
    release_reason TEXT,
    refund_reason TEXT,
    dispute_reason TEXT,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(order_id)
);

-- Payout requests for withdrawals
CREATE TABLE payout_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Payout details
    freti_amount DECIMAL(18,6) NOT NULL,
    estimated_local_amount DECIMAL(18,2), -- Estimated amount in local currency
    local_currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    
    -- Status tracking
    status VARCHAR(20) NOT NULL DEFAULT 'requested' CHECK (status IN (
        'requested', 'pending', 'processing', 'paid', 'failed', 'cancelled'
    )),
    
    -- External references
    external_payout_id VARCHAR(255), -- ID from payment provider
    webhook_data JSONB, -- Data from payment provider webhooks
    
    -- Timing
    requested_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processed_at TIMESTAMP WITH TIME ZONE,
    paid_at TIMESTAMP WITH TIME ZONE,
    
    -- Failure details
    failure_reason TEXT,
    retry_count INTEGER DEFAULT 0,
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Deposit records
CREATE TABLE deposits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Deposit details
    freti_amount DECIMAL(18,6) NOT NULL,
    local_amount DECIMAL(18,2) NOT NULL,
    local_currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    exchange_rate DECIMAL(10,6), -- Rate used for conversion
    
    -- Status tracking
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
        'pending', 'processing', 'completed', 'failed', 'cancelled'
    )),
    
    -- External references
    external_payment_id VARCHAR(255), -- ID from payment provider
    webhook_data JSONB, -- Data from payment provider webhooks
    
    -- Timing
    initiated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    
    -- Failure details
    failure_reason TEXT,
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Trust scores for escrow bypass
CREATE TABLE trust_scores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Trust metrics
    vendor_trust_score INTEGER DEFAULT 0, -- 0-1000 scale
    rider_trust_score INTEGER DEFAULT 0, -- 0-1000 scale
    buyer_trust_score INTEGER DEFAULT 0, -- 0-1000 scale
    
    -- Factors contributing to trust
    completed_orders INTEGER DEFAULT 0,
    successful_deliveries INTEGER DEFAULT 0,
    dispute_count INTEGER DEFAULT 0,
    refund_rate DECIMAL(5,2) DEFAULT 0.00, -- Percentage
    
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

-- Risk flags for fraud prevention
CREATE TABLE risk_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Flag details
    flag_type VARCHAR(50) NOT NULL CHECK (flag_type IN (
        'velocity_limit', 'suspicious_activity', 'chargebacks', 
        'fraud_investigation', 'manual_review', 'account_freeze'
    )),
    flag_reason TEXT NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    
    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    resolved_at TIMESTAMP WITH TIME ZONE,
    resolved_by UUID REFERENCES user_profiles(id),
    resolution_notes TEXT,
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_wallets_user_id ON wallets(user_id);
CREATE INDEX idx_wallet_ledger_wallet_id ON wallet_ledger(wallet_id);
CREATE INDEX idx_wallet_ledger_transaction_type ON wallet_ledger(transaction_type);
CREATE INDEX idx_wallet_ledger_reference ON wallet_ledger(reference_type, reference_id);
CREATE INDEX idx_wallet_ledger_created_at ON wallet_ledger(created_at DESC);
CREATE INDEX idx_orders_buyer_id ON orders(buyer_id);
CREATE INDEX idx_orders_vendor_id ON orders(vendor_id);
CREATE INDEX idx_orders_rider_id ON orders(rider_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX idx_escrows_order_id ON escrows(order_id);
CREATE INDEX idx_escrows_status ON escrows(status);
CREATE INDEX idx_payout_requests_user_id ON payout_requests(user_id);
CREATE INDEX idx_payout_requests_status ON payout_requests(status);
CREATE INDEX idx_deposits_user_id ON deposits(user_id);
CREATE INDEX idx_deposits_status ON deposits(status);
CREATE INDEX idx_trust_scores_user_id ON trust_scores(user_id);
CREATE INDEX idx_risk_flags_user_id ON risk_flags(user_id);
CREATE INDEX idx_risk_flags_active ON risk_flags(is_active, user_id);

-- Functions for wallet operations
CREATE OR REPLACE FUNCTION update_wallet_balances()
RETURNS TRIGGER AS $$
BEGIN
    -- Update wallet balances based on ledger entry
    UPDATE wallets 
    SET 
        available_balance = available_balance + NEW.available_delta,
        escrow_balance = escrow_balance + NEW.escrow_delta,
        pending_withdrawal = pending_withdrawal + NEW.pending_withdrawal_delta,
        updated_at = NOW()
    WHERE id = NEW.wallet_id;
    
    -- Verify balances are non-negative (safety check)
    IF EXISTS (
        SELECT 1 FROM wallets 
        WHERE id = NEW.wallet_id 
        AND (available_balance < 0 OR escrow_balance < 0 OR pending_withdrawal < 0)
    ) THEN
        RAISE EXCEPTION 'Wallet balance cannot be negative';
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update wallet balances
CREATE TRIGGER update_wallet_balances_trigger
    AFTER INSERT ON wallet_ledger
    FOR EACH ROW EXECUTE FUNCTION update_wallet_balances();

-- Function to create wallet for new users
CREATE OR REPLACE FUNCTION create_user_wallet()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO wallets (user_id) VALUES (NEW.id);
    INSERT INTO trust_scores (user_id) VALUES (NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to create wallet for new users
CREATE TRIGGER create_user_wallet_trigger
    AFTER INSERT ON user_profiles
    FOR EACH ROW EXECUTE FUNCTION create_user_wallet();

-- Function for timestamp updates
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply update triggers
CREATE TRIGGER update_wallets_updated_at 
    BEFORE UPDATE ON wallets 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_orders_updated_at 
    BEFORE UPDATE ON orders 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_escrows_updated_at 
    BEFORE UPDATE ON escrows 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_payout_requests_updated_at 
    BEFORE UPDATE ON payout_requests 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_deposits_updated_at 
    BEFORE UPDATE ON deposits 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_trust_scores_updated_at 
    BEFORE UPDATE ON trust_scores 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_risk_flags_updated_at 
    BEFORE UPDATE ON risk_flags 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Initialize wallets for existing users
INSERT INTO wallets (user_id)
SELECT id FROM user_profiles
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO trust_scores (user_id)
SELECT id FROM user_profiles
ON CONFLICT (user_id) DO NOTHING;

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON wallets TO authenticated;
GRANT SELECT ON wallet_ledger TO authenticated;
GRANT SELECT, INSERT, UPDATE ON orders TO authenticated;
GRANT SELECT, INSERT ON order_items TO authenticated;
GRANT SELECT ON escrows TO authenticated;
GRANT SELECT, INSERT ON payout_requests TO authenticated;
GRANT SELECT, INSERT ON deposits TO authenticated;
GRANT SELECT ON trust_scores TO authenticated;
GRANT SELECT ON risk_flags TO authenticated;

-- Service role needs full access for system operations
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;

COMMIT;