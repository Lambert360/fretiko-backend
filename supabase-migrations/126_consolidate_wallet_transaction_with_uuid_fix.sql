-- =====================================================
-- CONSOLIDATED PROCESS_WALLET_TRANSACTION WITH UUID FIX
-- =====================================================
-- This migration consolidates all previous wallet transaction migrations
-- and fixes the UUID casting issue properly
-- 
-- Includes:
-- - All transaction types (vendor_sale, platform_commission, sales tracking)
-- - Proper UUID casting with NULL handling
-- - Exception handling for invalid UUIDs
-- - Sales ledger integration
-- =====================================================

DROP FUNCTION IF EXISTS process_wallet_transaction(UUID, TEXT, DECIMAL, TEXT, TEXT, TEXT);

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
  -- 🔥 FIX: Variables to hold casted UUIDs with proper NULL handling
  v_reference_id_uuid UUID;
  v_order_id_uuid UUID;
  v_escrow_id_uuid UUID;
BEGIN
  -- 🔥 FIX: Cast reference_id to UUID once, handling NULL and empty strings
  -- This prevents "column reference_id is of type uuid but expression is of type text" errors
  IF p_reference_id IS NULL OR trim(p_reference_id) = '' THEN
    v_reference_id_uuid := NULL;
    v_order_id_uuid := NULL;
    v_escrow_id_uuid := NULL;
  ELSE
    BEGIN
      -- Cast for wallet_ledger reference_id
      v_reference_id_uuid := p_reference_id::UUID;
      
      -- Cast for sales_ledger (order_id or escrow_id based on reference_type)
      IF p_reference_type = 'order' THEN
        v_order_id_uuid := p_reference_id::UUID;
        v_escrow_id_uuid := NULL;
      ELSIF p_reference_type = 'escrow' THEN
        v_escrow_id_uuid := p_reference_id::UUID;
        v_order_id_uuid := NULL;
      ELSE
        v_order_id_uuid := NULL;
        v_escrow_id_uuid := NULL;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- If cast fails (invalid UUID format), set to NULL
      v_reference_id_uuid := NULL;
      v_order_id_uuid := NULL;
      v_escrow_id_uuid := NULL;
      RAISE WARNING 'Invalid reference_id format: %, setting to NULL', p_reference_id;
    END;
  END IF;

  -- 1. Get wallet and current balances (including sales tracking)
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
  FOR UPDATE; -- Lock the row to prevent race conditions

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

    -- ✅ PLATFORM COMMISSION: Credit available (no sales tracking)
    WHEN 'platform_commission' THEN
      v_available_delta := p_amount;
      v_new_available := v_current_available + p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;
      -- Platform commission doesn't affect sales/earnings tracking

    -- Other credits to available balance
    WHEN 'deposit_mint', 'escrow_refund', 'reward_credit', 'admin_adjustment', 'vendor_sale' THEN
      v_available_delta := p_amount;
      v_new_available := v_current_available + p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    -- Debit from available, add to escrow (purchase hold)
    WHEN 'purchase_hold' THEN
      v_available_delta := -p_amount;
      v_escrow_delta := p_amount;
      v_new_available := v_current_available - p_amount;
      v_new_escrow := v_current_escrow + p_amount;
      v_new_pending := v_current_pending;

    -- Debit from available balance (withdrawal, fee)
    WHEN 'withdrawal_burn', 'fee_deduction' THEN
      v_available_delta := -p_amount;
      v_new_available := v_current_available - p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    -- Debit from available, add to pending withdrawal
    WHEN 'withdrawal_request' THEN
      v_available_delta := -p_amount;
      v_pending_delta := p_amount;
      v_new_available := v_current_available - p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending + p_amount;

    -- Debit from escrow (escrow release already handled above)
    WHEN 'escrow_release_to_platform' THEN
      v_escrow_delta := -p_amount;
      v_new_available := v_current_available;
      v_new_escrow := v_current_escrow - p_amount;
      v_new_pending := v_current_pending;

    ELSE
      RAISE EXCEPTION 'Unknown transaction type: %', p_transaction_type;
  END CASE;

  -- 3. Validate balances (no negative balances)
  IF v_new_available < 0 THEN
    RAISE EXCEPTION 'Insufficient available balance: % required, % available', p_amount, v_current_available;
  END IF;

  IF v_new_escrow < 0 THEN
    RAISE EXCEPTION 'Insufficient escrow balance';
  END IF;

  IF v_new_pending < 0 THEN
    RAISE EXCEPTION 'Insufficient pending withdrawal balance';
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

  -- 5. Create wallet ledger entry with properly casted UUID
  INSERT INTO wallet_ledger (
    id, wallet_id, user_id, transaction_type,
    available_delta, escrow_delta, pending_withdrawal_delta,
    available_balance_after, escrow_balance_after, pending_withdrawal_after,
    reference_type, reference_id, description, created_at, created_by
  ) VALUES (
    gen_random_uuid(), v_wallet_id, p_user_id, p_transaction_type,
    v_available_delta, v_escrow_delta, v_pending_delta,
    v_new_available, v_new_escrow, v_new_pending,
    p_reference_type, v_reference_id_uuid, p_description, NOW(), p_user_id
  )
  RETURNING id INTO v_transaction_id;

  -- 6. Create sales ledger entry (if applicable - only for escrow_release and delivery_payment)
  IF p_transaction_type IN ('escrow_release', 'delivery_payment') THEN
    -- Ensure sales_ledger table exists (created by add-sales-tracking.sql)
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
      v_order_id_uuid,  -- 🔥 FIX: Use pre-casted UUID variable (NULL if not order type)
      v_escrow_id_uuid, -- 🔥 FIX: Use pre-casted UUID variable (NULL if not escrow type)
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
    'previous_escrow', v_current_escrow,
    'new_escrow', v_new_escrow,
    'previous_pending', v_current_pending,
    'new_pending', v_new_pending,
    'previous_vendor_sales', v_current_vendor_sales,
    'new_vendor_sales', v_new_vendor_sales,
    'previous_rider_earnings', v_current_rider_earnings,
    'new_rider_earnings', v_new_rider_earnings,
    'lifetime_revenue', v_new_lifetime_revenue,
    'available_delta', v_available_delta,
    'escrow_delta', v_escrow_delta,
    'pending_delta', v_pending_delta
  );

EXCEPTION
  WHEN OTHERS THEN
    -- Log error and return failure
    RAISE WARNING 'process_wallet_transaction failed: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$;

-- Grant execute permission to authenticated users and service role
GRANT EXECUTE ON FUNCTION process_wallet_transaction(UUID, TEXT, DECIMAL, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION process_wallet_transaction(UUID, TEXT, DECIMAL, TEXT, TEXT, TEXT) TO service_role;

-- Add comment
COMMENT ON FUNCTION process_wallet_transaction IS 
'Atomically process wallet transactions with balance updates and ledger entries. 
CONSOLIDATED VERSION - Includes all transaction types (vendor_sale, platform_commission, sales tracking) 
and fixes UUID casting issue with proper NULL handling.';

-- =====================================================
-- VERIFICATION NOTES
-- =====================================================
-- This migration consolidates:
-- 1. create-process-wallet-transaction-rpc.sql (original)
-- 2. add-vendor-sale-transaction-type.sql (vendor_sale support)
-- 3. add-sales-tracking.sql (sales_ledger integration)
-- 4. add-platform-commission-transaction-type.sql (platform_commission support)
-- 5. fix-process-wallet-transaction-uuid-cast.sql (UUID casting fix)
--
-- Key fixes:
-- - Uses DECLARE variables (v_reference_id_uuid, v_order_id_uuid, v_escrow_id_uuid) 
--   for proper UUID casting with exception handling
-- - Handles NULL and empty strings before casting
-- - Fixes both wallet_ledger and sales_ledger INSERT statements
-- - Includes all latest features (sales tracking, all transaction types)

