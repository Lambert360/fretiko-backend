-- =====================================================
-- ADD SALES TRACKING TO WALLET SYSTEM
-- Track total sales for vendors and riders separately
-- =====================================================

-- 1. Add sales columns to wallets table
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS total_vendor_sales DECIMAL(20, 2) DEFAULT 0.0;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS total_rider_earnings DECIMAL(20, 2) DEFAULT 0.0;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS lifetime_revenue DECIMAL(20, 2) DEFAULT 0.0;

-- Add comments
COMMENT ON COLUMN wallets.total_vendor_sales IS 'Total sales received as a vendor (cumulative)';
COMMENT ON COLUMN wallets.total_rider_earnings IS 'Total earnings received as a rider (cumulative)';
COMMENT ON COLUMN wallets.lifetime_revenue IS 'Combined total of vendor sales + rider earnings';

-- 2. Create sales_ledger table for detailed tracking
CREATE TABLE IF NOT EXISTS sales_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  
  -- Transaction details
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('vendor_sale', 'rider_delivery')),
  amount DECIMAL(20, 2) NOT NULL,
  
  -- Reference to source
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  escrow_id UUID REFERENCES escrows(id) ON DELETE SET NULL,
  
  -- Running totals (snapshot at time of transaction)
  vendor_sales_after DECIMAL(20, 2),
  rider_earnings_after DECIMAL(20, 2),
  lifetime_revenue_after DECIMAL(20, 2),
  
  -- Metadata
  description TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by UUID REFERENCES auth.users(id)
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_sales_ledger_user_id ON sales_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_ledger_wallet_id ON sales_ledger(wallet_id);
CREATE INDEX IF NOT EXISTS idx_sales_ledger_order_id ON sales_ledger(order_id);
CREATE INDEX IF NOT EXISTS idx_sales_ledger_created_at ON sales_ledger(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_ledger_transaction_type ON sales_ledger(transaction_type);
CREATE INDEX IF NOT EXISTS idx_sales_ledger_user_type ON sales_ledger(user_id, transaction_type, created_at DESC);

-- Add comments
COMMENT ON TABLE sales_ledger IS 'Tracks all sales/revenue for vendors and riders separately from wallet transactions';
COMMENT ON COLUMN sales_ledger.transaction_type IS 'Type of sale: vendor_sale or rider_delivery';
COMMENT ON COLUMN sales_ledger.amount IS 'Amount of this sale/earning';
COMMENT ON COLUMN sales_ledger.vendor_sales_after IS 'Total vendor sales after this transaction';
COMMENT ON COLUMN sales_ledger.rider_earnings_after IS 'Total rider earnings after this transaction';
COMMENT ON COLUMN sales_ledger.lifetime_revenue_after IS 'Combined revenue after this transaction';

-- 3. Update process_wallet_transaction to track sales
CREATE OR REPLACE FUNCTION process_wallet_transaction(
  p_user_id UUID,
  p_transaction_type TEXT,
  p_amount DECIMAL,
  p_description TEXT,
  p_reference_id TEXT DEFAULT NULL,
  p_reference_type TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_wallet_id UUID;
  v_current_available DECIMAL;
  v_current_escrow DECIMAL;
  v_current_pending DECIMAL;
  v_current_vendor_sales DECIMAL;
  v_current_rider_earnings DECIMAL;
  v_current_lifetime_revenue DECIMAL;
  v_new_available DECIMAL;
  v_new_escrow DECIMAL;
  v_new_pending DECIMAL;
  v_new_vendor_sales DECIMAL;
  v_new_rider_earnings DECIMAL;
  v_new_lifetime_revenue DECIMAL;
  v_transaction_id UUID;
  v_available_delta DECIMAL := 0;
  v_escrow_delta DECIMAL := 0;
  v_pending_delta DECIMAL := 0;
BEGIN
  -- 1. Get wallet and current balances (including sales)
  SELECT 
    id, 
    available_balance, 
    escrow_balance, 
    pending_withdrawal,
    COALESCE(total_vendor_sales, 0),
    COALESCE(total_rider_earnings, 0),
    COALESCE(lifetime_revenue, 0)
  INTO 
    v_wallet_id, 
    v_current_available, 
    v_current_escrow, 
    v_current_pending,
    v_current_vendor_sales,
    v_current_rider_earnings,
    v_current_lifetime_revenue
  FROM wallets
  WHERE user_id = p_user_id
  FOR UPDATE; -- Lock the row

  -- If wallet doesn't exist, create it
  IF v_wallet_id IS NULL THEN
    INSERT INTO wallets (
      id, user_id, available_balance, escrow_balance, pending_withdrawal,
      total_vendor_sales, total_rider_earnings, lifetime_revenue,
      preferred_currency, kyc_status, daily_deposit_limit, daily_withdrawal_limit,
      created_at, updated_at
    ) VALUES (
      gen_random_uuid(), p_user_id, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
      'USD', 'pending', 10000.0, 5000.0, NOW(), NOW()
    )
    RETURNING id, available_balance, escrow_balance, pending_withdrawal, 
              total_vendor_sales, total_rider_earnings, lifetime_revenue
    INTO v_wallet_id, v_current_available, v_current_escrow, v_current_pending,
         v_current_vendor_sales, v_current_rider_earnings, v_current_lifetime_revenue;
  END IF;

  -- Initialize new sales values
  v_new_vendor_sales := v_current_vendor_sales;
  v_new_rider_earnings := v_current_rider_earnings;
  v_new_lifetime_revenue := v_current_lifetime_revenue;

  -- 2. Calculate deltas based on transaction type
  CASE p_transaction_type
    -- ✅ VENDOR SALE: Credit available + track as vendor sale
    WHEN 'escrow_release' THEN
      v_available_delta := p_amount;
      v_new_available := v_current_available + p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;
      
      -- Track as vendor sale
      v_new_vendor_sales := v_current_vendor_sales + p_amount;
      v_new_lifetime_revenue := v_current_lifetime_revenue + p_amount;

    -- ✅ RIDER DELIVERY FEE: Credit available + track as rider earnings
    WHEN 'delivery_payment' THEN
      v_available_delta := p_amount;
      v_new_available := v_current_available + p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;
      
      -- Track as rider earnings
      v_new_rider_earnings := v_current_rider_earnings + p_amount;
      v_new_lifetime_revenue := v_current_lifetime_revenue + p_amount;

    -- Other transaction types (deposit, withdrawal, etc.)
    WHEN 'deposit_mint', 'escrow_refund', 'reward_credit', 'admin_adjustment' THEN
      v_available_delta := p_amount;
      v_new_available := v_current_available + p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    WHEN 'purchase_hold' THEN
      v_available_delta := -p_amount;
      v_escrow_delta := p_amount;
      v_new_available := v_current_available - p_amount;
      v_new_escrow := v_current_escrow + p_amount;
      v_new_pending := v_current_pending;

    WHEN 'withdrawal_burn', 'fee_deduction' THEN
      v_available_delta := -p_amount;
      v_new_available := v_current_available - p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    WHEN 'withdrawal_request' THEN
      v_available_delta := -p_amount;
      v_pending_delta := p_amount;
      v_new_available := v_current_available - p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending + p_amount;

    WHEN 'escrow_release_to_platform' THEN
      v_escrow_delta := -p_amount;
      v_new_available := v_current_available;
      v_new_escrow := v_current_escrow - p_amount;
      v_new_pending := v_current_pending;

    ELSE
      RAISE EXCEPTION 'Unknown transaction type: %', p_transaction_type;
  END CASE;

  -- 3. Validate balances
  IF v_new_available < 0 THEN
    RAISE EXCEPTION 'Insufficient available balance: % required, % available', p_amount, v_current_available;
  END IF;

  -- 4. Update wallet balances (including sales tracking)
  UPDATE wallets
  SET
    available_balance = v_new_available,
    escrow_balance = v_new_escrow,
    pending_withdrawal = v_new_pending,
    total_vendor_sales = v_new_vendor_sales,
    total_rider_earnings = v_new_rider_earnings,
    lifetime_revenue = v_new_lifetime_revenue,
    updated_at = NOW()
  WHERE id = v_wallet_id;

  -- 5. Create wallet ledger entry
  INSERT INTO wallet_ledger (
    id, wallet_id, user_id, transaction_type,
    available_delta, escrow_delta, pending_withdrawal_delta,
    available_balance_after, escrow_balance_after, pending_withdrawal_after,
    reference_type, reference_id, description, created_at, created_by
  ) VALUES (
    gen_random_uuid(), v_wallet_id, p_user_id, p_transaction_type,
    v_available_delta, v_escrow_delta, v_pending_delta,
    v_new_available, v_new_escrow, v_new_pending,
    p_reference_type, p_reference_id, p_description, NOW(), p_user_id
  )
  RETURNING id INTO v_transaction_id;

  -- 6. Create sales ledger entry (if applicable)
  IF p_transaction_type IN ('escrow_release', 'delivery_payment') THEN
    INSERT INTO sales_ledger (
      id, user_id, wallet_id, transaction_type, amount,
      order_id, escrow_id,
      vendor_sales_after, rider_earnings_after, lifetime_revenue_after,
      description, created_at, created_by
    ) VALUES (
      gen_random_uuid(),
      p_user_id,
      v_wallet_id,
      CASE WHEN p_transaction_type = 'escrow_release' THEN 'vendor_sale' ELSE 'rider_delivery' END,
      p_amount,
      CASE WHEN p_reference_type = 'order' THEN p_reference_id::UUID ELSE NULL END,
      CASE WHEN p_reference_type = 'escrow' THEN p_reference_id::UUID ELSE NULL END,
      v_new_vendor_sales,
      v_new_rider_earnings,
      v_new_lifetime_revenue,
      p_description,
      NOW(),
      p_user_id
    );
  END IF;

  -- 7. Return transaction details
  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'wallet_id', v_wallet_id,
    'previous_available', v_current_available,
    'new_available', v_new_available,
    'previous_vendor_sales', v_current_vendor_sales,
    'new_vendor_sales', v_new_vendor_sales,
    'previous_rider_earnings', v_current_rider_earnings,
    'new_rider_earnings', v_new_rider_earnings,
    'lifetime_revenue', v_new_lifetime_revenue
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'process_wallet_transaction failed: %', SQLERRM;
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION process_wallet_transaction(UUID, TEXT, DECIMAL, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION process_wallet_transaction(UUID, TEXT, DECIMAL, TEXT, TEXT, TEXT) TO service_role;

-- 4. Enable RLS on sales_ledger
ALTER TABLE sales_ledger ENABLE ROW LEVEL SECURITY;

-- Users can only view their own sales
CREATE POLICY "Users can view own sales ledger"
  ON sales_ledger FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can do everything
CREATE POLICY "Service role has full access to sales ledger"
  ON sales_ledger FOR ALL
  USING (auth.role() = 'service_role');

-- =====================================================
-- VERIFICATION
-- =====================================================

-- Check new columns exist
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'wallets'
AND column_name IN ('total_vendor_sales', 'total_rider_earnings', 'lifetime_revenue');

-- Check sales_ledger table exists
SELECT table_name FROM information_schema.tables WHERE table_name = 'sales_ledger';

