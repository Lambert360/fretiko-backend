-- =====================================================
-- ADD IDEMPOTENCY CHECKING TO PROCESS_WALLET_TRANSACTION
-- Prevents duplicate transactions with same reference_id, reference_type, and transaction_type
-- =====================================================

-- Update the function to check for existing transactions before creating new ones
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
  v_current_vendor_sales DECIMAL := 0;
  v_current_rider_earnings DECIMAL := 0;
  v_current_lifetime_revenue DECIMAL := 0;
  v_new_available DECIMAL;
  v_new_escrow DECIMAL;
  v_new_pending DECIMAL;
  v_new_vendor_sales DECIMAL := 0;
  v_new_rider_earnings DECIMAL := 0;
  v_new_lifetime_revenue DECIMAL := 0;
  v_transaction_id UUID;
  v_available_delta DECIMAL := 0;
  v_escrow_delta DECIMAL := 0;
  v_pending_delta DECIMAL := 0;
  
  -- Idempotency checking variables
  v_reference_id_uuid UUID;
  v_existing_transaction_id UUID;
  v_existing_transaction JSONB;
  
  -- Sales ledger casting variables
  v_order_id_uuid UUID;
  v_escrow_id_uuid UUID;
BEGIN
  -- ✅ IDEMPOTENCY CHECK: Check if transaction with same reference already exists
  -- Only check if reference_id and reference_type are provided
  IF p_reference_id IS NOT NULL AND p_reference_id != '' AND p_reference_type IS NOT NULL THEN
    -- Try to cast reference_id to UUID
    BEGIN
      v_reference_id_uuid := p_reference_id::UUID;
    EXCEPTION WHEN OTHERS THEN
      -- If casting fails, use NULL (will check with TEXT comparison)
      v_reference_id_uuid := NULL;
    END;
    
    -- Check for existing transaction with same user, reference, and type
    -- Check both UUID and TEXT reference_id to handle both cases
    SELECT id INTO v_existing_transaction_id
    FROM wallet_ledger
    WHERE user_id = p_user_id
      AND transaction_type = p_transaction_type
      AND reference_type = p_reference_type
      AND (
        (v_reference_id_uuid IS NOT NULL AND reference_id = v_reference_id_uuid)
        OR (v_reference_id_uuid IS NULL AND reference_id::TEXT = p_reference_id)
      )
    LIMIT 1;
    
    -- If existing transaction found, return it (idempotent response)
    IF v_existing_transaction_id IS NOT NULL THEN
      -- Fetch the existing transaction details
      SELECT jsonb_build_object(
        'success', true,
        'transaction_id', id,
        'wallet_id', wallet_id,
        'previous_available', available_balance_after - available_delta,
        'new_available', available_balance_after,
        'previous_escrow', escrow_balance_after - escrow_delta,
        'new_escrow', escrow_balance_after,
        'previous_pending', pending_withdrawal_after - pending_withdrawal_delta,
        'new_pending', pending_withdrawal_after,
        'available_delta', available_delta,
        'escrow_delta', escrow_delta,
        'pending_delta', pending_withdrawal_delta,
        'idempotent', true
      )
      INTO v_existing_transaction
      FROM wallet_ledger
      WHERE id = v_existing_transaction_id;
      
      -- Return existing transaction (idempotent)
      RETURN COALESCE(v_existing_transaction, jsonb_build_object(
        'success', true,
        'transaction_id', v_existing_transaction_id,
        'idempotent', true,
        'message', 'Transaction already exists'
      ));
    END IF;
  END IF;

  -- ✅ Continue with normal transaction processing (no duplicate found)
  -- 1. Get wallet and current balances (including sales) with row-level lock
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

  -- 4. Cast reference_id to UUID if possible (handle NULL and empty strings)
  -- This is done after idempotency check since we may have already cast it
  -- If not cast yet, cast it now
  IF v_reference_id_uuid IS NULL AND p_reference_id IS NOT NULL AND p_reference_id != '' THEN
    BEGIN
      v_reference_id_uuid := p_reference_id::UUID;
    EXCEPTION WHEN OTHERS THEN
      v_reference_id_uuid := NULL;
    END;
  END IF;
  
  -- Set order_id or escrow_id based on reference_type (for sales_ledger)
  IF p_reference_type = 'order' AND v_reference_id_uuid IS NOT NULL THEN
    v_order_id_uuid := v_reference_id_uuid;
    v_escrow_id_uuid := NULL;
  ELSIF p_reference_type = 'escrow' AND v_reference_id_uuid IS NOT NULL THEN
    v_escrow_id_uuid := v_reference_id_uuid;
    v_order_id_uuid := NULL;
  ELSE
    v_order_id_uuid := NULL;
    v_escrow_id_uuid := NULL;
  END IF;

  -- 5. Update wallet balances (including sales tracking)
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

  -- 6. Create wallet ledger entry with properly casted UUID
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

  -- 7. Create sales ledger entry (if applicable - only for escrow_release and delivery_payment)
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
      v_order_id_uuid,
      v_escrow_id_uuid,
      v_new_vendor_sales,
      v_new_rider_earnings,
      v_new_lifetime_revenue,
      p_description,
      NOW(),
      p_user_id
    );
  END IF;

  -- 8. Return transaction details
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
    'pending_delta', v_pending_delta,
    'idempotent', false
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

-- Create index to improve idempotency check performance
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_idempotency 
ON wallet_ledger(user_id, transaction_type, reference_type, reference_id)
WHERE reference_id IS NOT NULL AND reference_type IS NOT NULL;

-- Add comment explaining idempotency
COMMENT ON FUNCTION process_wallet_transaction IS 
'Processes wallet transactions atomically with row-level locking.
NOW INCLUDES IDEMPOTENCY CHECKING: If a transaction with the same user_id, reference_id, reference_type, and transaction_type already exists, 
returns the existing transaction instead of creating a duplicate. This prevents duplicate transactions from concurrent requests.';

