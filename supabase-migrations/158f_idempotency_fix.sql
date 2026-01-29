-- =====================================================
-- IDEMPOTENCY FIX: Add Advisory Lock Protection Only
-- Migration: 158f
-- Date: 2026-01-28
-- Description: Add only the missing advisory lock protection to prevent race conditions
-- This is a minimal fix - only adds what was missing from 158e
-- =====================================================

-- Add advisory lock protection by recreating function with minimal changes
-- This preserves all existing logic from 158e and only adds advisory locks

DROP FUNCTION IF EXISTS process_wallet_transaction(p_user_id UUID, p_transaction_type TEXT, p_amount NUMERIC, p_description TEXT, p_reference_id TEXT, p_reference_type TEXT);

-- Copy the exact function from 158e but add advisory lock variable and logic
CREATE OR REPLACE FUNCTION process_wallet_transaction(
  p_user_id UUID,
  p_transaction_type TEXT,
  p_amount NUMERIC,
  p_description TEXT,
  p_reference_id TEXT DEFAULT NULL,
  p_reference_type TEXT DEFAULT NULL
)
RETURNS TABLE(
  success BOOLEAN,
  transaction_id UUID,
  new_available_balance NUMERIC,
  new_escrow_balance NUMERIC,
  new_pending_withdrawal NUMERIC,
  error_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  -- Wallet balance variables (exact same as 158e)
  v_current_available NUMERIC;
  v_current_escrow NUMERIC;
  v_current_pending NUMERIC;
  v_new_available NUMERIC;
  v_new_escrow NUMERIC;
  v_new_pending NUMERIC;
  
  -- Transaction delta variables (exact same as 158e)
  v_available_delta NUMERIC;
  v_escrow_delta NUMERIC;
  v_pending_delta NUMERIC;
  
  -- Sales tracking variables (exact same as 158e)
  v_current_vendor_sales NUMERIC DEFAULT 0;
  v_current_rider_earnings NUMERIC DEFAULT 0;
  v_current_lifetime_revenue NUMERIC DEFAULT 0;
  v_new_vendor_sales NUMERIC;
  v_new_rider_earnings NUMERIC;
  v_new_lifetime_revenue NUMERIC;
  
  -- Transaction record (exact same as 158e)
  v_transaction_id UUID;
  v_wallet_id UUID;
  
  -- Idempotency check (exact same as 158e)
  v_existing_id UUID;
  v_lock_key BIGINT; -- ✅ ADD: Advisory lock key (only addition)
BEGIN
  -- Get user's wallet (exact same as 158e)
  SELECT id, available_balance, escrow_balance, pending_withdrawal, 
         total_vendor_sales, total_rider_earnings, lifetime_revenue
  INTO v_wallet_id, v_current_available, v_current_escrow, v_current_pending,
       v_current_vendor_sales, v_current_rider_earnings, v_current_lifetime_revenue
  FROM wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  -- Check if wallet exists (exact same as 158e)
  IF v_wallet_id IS NULL THEN
    RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, 0::NUMERIC, 0::NUMERIC, 0::NUMERIC, 'Wallet not found for user'::TEXT;
    RETURN;
  END IF;

  -- ✅ ADD: Advisory lock protection (only addition)
  IF p_reference_id IS NOT NULL AND p_reference_id != '' AND p_reference_type IS NOT NULL THEN
    v_lock_key := abs(hashtext(p_user_id::TEXT || p_transaction_type || p_reference_type || p_reference_id));
    PERFORM pg_advisory_xact_lock(v_lock_key);
  END IF;
  
  -- Now check for existing transaction (exact same as 158e)
  SELECT id INTO v_existing_id
  FROM wallet_ledger
  WHERE user_id = p_user_id
    AND transaction_type = p_transaction_type
    AND reference_id = p_reference_id::UUID
    AND reference_type = p_reference_type
    AND created_at > NOW() - INTERVAL '1 hour'
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    -- Return existing transaction details (exact same as 158e)
    SELECT available_balance, escrow_balance, pending_withdrawal
    INTO v_current_available, v_current_escrow, v_current_pending
    FROM wallets
    WHERE user_id = p_user_id;
    
    RETURN QUERY SELECT TRUE::BOOLEAN, v_existing_id, v_current_available, v_current_escrow, v_current_pending, 'Idempotent: transaction already processed'::TEXT;
    RETURN;
  END IF;

  -- Initialize sales tracking variables (exact same as 158e)
  v_new_vendor_sales := v_current_vendor_sales;
  v_new_rider_earnings := v_current_rider_earnings;
  v_new_lifetime_revenue := v_current_lifetime_revenue;

  -- 2. Calculate deltas based on transaction type (exact same as 158e)
  CASE p_transaction_type
    WHEN 'escrow_release' THEN
      v_available_delta := p_amount;
      v_escrow_delta := 0;
      v_pending_delta := 0;
      v_new_available := v_current_available + p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;
      v_new_vendor_sales := v_current_vendor_sales + p_amount;
      v_new_lifetime_revenue := v_current_lifetime_revenue + p_amount;

    WHEN 'delivery_payment' THEN
      v_available_delta := p_amount;
      v_escrow_delta := 0;
      v_pending_delta := 0;
      v_new_available := v_current_available + p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;
      v_new_rider_earnings := v_current_rider_earnings + p_amount;
      v_new_lifetime_revenue := v_current_lifetime_revenue + p_amount;

    WHEN 'deposit_mint', 'reward_credit', 'admin_adjustment' THEN
      v_available_delta := p_amount;
      v_escrow_delta := 0;
      v_pending_delta := 0;
      v_new_available := v_current_available + p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    WHEN 'purchase_hold' THEN
      v_available_delta := -p_amount;
      v_escrow_delta := p_amount;
      v_pending_delta := 0;
      v_new_available := v_current_available - p_amount;
      v_new_escrow := v_current_escrow + p_amount;
      v_new_pending := v_current_pending;

    WHEN 'escrow_refund' THEN
      v_escrow_delta := -p_amount;
      v_available_delta := ABS(p_amount);
      v_pending_delta := 0;
      v_new_escrow := v_current_escrow - p_amount;
      v_new_available := v_current_available + ABS(p_amount);
      v_new_pending := v_current_pending;

    WHEN 'withdrawal_burn', 'fee_deduction', 'gift_purchase' THEN
      v_available_delta := -p_amount;
      v_escrow_delta := 0;
      v_pending_delta := 0;
      v_new_available := v_current_available - p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    WHEN 'gift_conversion' THEN
      v_available_delta := p_amount;
      v_escrow_delta := 0;
      v_pending_delta := 0;
      v_new_available := v_current_available + p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    WHEN 'withdrawal_request' THEN
      v_available_delta := -p_amount;
      v_escrow_delta := 0;
      v_pending_delta := p_amount;
      v_new_available := v_current_available - p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending + p_amount;

    WHEN 'platform_commission' THEN
      v_available_delta := 0;
      v_escrow_delta := -p_amount;
      v_pending_delta := 0;
      v_new_available := v_current_available;
      v_new_escrow := v_current_escrow - p_amount;
      v_new_pending := v_current_pending;

    ELSE
      RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, v_current_available, v_current_escrow, v_current_pending, 
                     ('Unknown transaction type: ' || p_transaction_type)::TEXT;
      RETURN;
  END CASE;

  -- 3. Validate sufficient balance for debit operations (exact same as 158e)
  IF p_transaction_type IN ('purchase_hold', 'withdrawal_burn', 'fee_deduction', 'withdrawal_request', 'gift_purchase') THEN
    IF v_current_available < ABS(v_available_delta) THEN
      RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, v_current_available, v_current_escrow, v_current_pending, 
                     'Insufficient available balance'::TEXT;
      RETURN;
    END IF;
  END IF;

  IF p_transaction_type = 'escrow_refund' THEN
    IF v_current_escrow < ABS(v_escrow_delta) THEN
      RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, v_current_available, v_current_escrow, v_current_pending, 
                     'Insufficient escrow balance'::TEXT;
      RETURN;
    END IF;
  END IF;

  IF p_transaction_type = 'platform_commission' THEN
    IF v_current_escrow < ABS(v_escrow_delta) THEN
      RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, v_current_available, v_current_escrow, v_current_pending, 
                     'Insufficient escrow balance for commission'::TEXT;
      RETURN;
    END IF;
  END IF;

  -- 4. Update wallet balances (exact same as 158e)
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

  -- 5. Create transaction record (exact same as 158e)
  INSERT INTO wallet_ledger (
    user_id,
    wallet_id,
    transaction_type,
    available_delta,
    escrow_delta,
    pending_withdrawal_delta,
    available_balance_after,
    escrow_balance_after,
    pending_withdrawal_after,
    reference_id,
    reference_type,
    description,
    created_by
  )
  VALUES (
    p_user_id,
    v_wallet_id,
    p_transaction_type,
    v_available_delta,
    v_escrow_delta,
    v_pending_delta,
    v_new_available,
    v_new_escrow,
    v_new_pending,
    p_reference_id,
    p_reference_type,
    p_description,
    p_user_id
  )
  RETURNING id INTO v_transaction_id;

  -- 6. Create sales ledger entry for vendor sales (exact same as 158e)
  IF p_transaction_type = 'escrow_release' THEN
    INSERT INTO sales_ledger (
      vendor_id,
      order_id,
      amount,
      commission_rate,
      commission_amount,
      net_amount,
      status,
      created_at
    )
    VALUES (
      p_user_id,
      p_reference_id,
      p_amount,
      0.02,
      p_amount * 0.02,
      p_amount * 0.98,
      'completed',
      NOW()
    );
  END IF;

  -- 7. Return success (exact same as 158e)
  RETURN QUERY SELECT TRUE::BOOLEAN, v_transaction_id, v_new_available, v_new_escrow, v_new_pending, NULL::TEXT;

EXCEPTION
  WHEN OTHERS THEN
    -- Log error and return failure (exact same as 158e)
    RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, v_current_available, v_current_escrow, v_current_pending, 
                   SQLERRM::TEXT;
END;
$$;

-- Add comment explaining the advisory lock fix
COMMENT ON FUNCTION process_wallet_transaction IS 
'Fixed with advisory lock protection in migration 158f to prevent race conditions and double charges.
Advisory locks ensure only one transaction with same reference can proceed at a time.
All other logic preserved from migration 158e.';

COMMIT;
