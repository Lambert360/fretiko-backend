-- Fix missing wallets table
-- This fixes the "relation 'wallets' does not exist" error

-- 1. Create wallets table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,

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

-- 2. Create wallet_ledger table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.wallet_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES public.wallets(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,

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

    -- Exchange rate info (when conversion happens)
    exchange_rate DECIMAL(10,6),
    local_currency VARCHAR(3),
    local_amount DECIMAL(18,6),

    -- Reference information
    reference_type VARCHAR(50), -- 'order', 'deposit', 'withdrawal', 'refund'
    reference_id UUID,

    -- Metadata and descriptions
    description TEXT,
    metadata JSONB DEFAULT '{}',
    processed_by UUID REFERENCES public.user_profiles(id), -- admin/system user

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Enable RLS on both tables
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_ledger ENABLE ROW LEVEL SECURITY;

-- 4. Create RLS policies for wallets
DROP POLICY IF EXISTS "Users can view own wallet" ON public.wallets;
DROP POLICY IF EXISTS "Users can update own wallet" ON public.wallets;

CREATE POLICY "Users can view own wallet" ON public.wallets
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own wallet" ON public.wallets
    FOR UPDATE USING (auth.uid() = user_id);

-- 5. Create RLS policies for wallet_ledger
DROP POLICY IF EXISTS "Users can view own transactions" ON public.wallet_ledger;

CREATE POLICY "Users can view own transactions" ON public.wallet_ledger
    FOR SELECT USING (auth.uid() = user_id);

-- 6. Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON public.wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_wallet_id ON public.wallet_ledger(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user_id ON public.wallet_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_type ON public.wallet_ledger(transaction_type);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_created_at ON public.wallet_ledger(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_reference ON public.wallet_ledger(reference_type, reference_id);

-- 7. Create trigger for updated_at
DROP TRIGGER IF EXISTS update_wallets_updated_at ON public.wallets;
CREATE TRIGGER update_wallets_updated_at
    BEFORE UPDATE ON public.wallets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 8. Create function to create wallet for new users
CREATE OR REPLACE FUNCTION public.create_user_wallet()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.wallets (user_id) VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 9. Create trigger to create wallet for new users
DROP TRIGGER IF EXISTS create_user_wallet_trigger ON public.user_profiles;
CREATE TRIGGER create_user_wallet_trigger
    AFTER INSERT ON public.user_profiles
    FOR EACH ROW EXECUTE FUNCTION public.create_user_wallet();

-- 10. Create wallets for any existing user profiles
INSERT INTO public.wallets (user_id)
SELECT id FROM public.user_profiles
WHERE NOT EXISTS (
    SELECT 1 FROM public.wallets
    WHERE wallets.user_id = user_profiles.id
)
ON CONFLICT (user_id) DO NOTHING;

-- 11. Grant necessary permissions
GRANT SELECT, UPDATE ON public.wallets TO authenticated;
GRANT SELECT ON public.wallet_ledger TO authenticated;
GRANT ALL ON public.wallets TO service_role;
GRANT ALL ON public.wallet_ledger TO service_role;

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'Wallets table and related components have been created successfully!';
    RAISE NOTICE 'User creation should now work without wallet-related errors';
END $$;