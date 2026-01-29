-- =====================================================
-- FIX WALLET TRANSACTION WITH ADVISORY LOCKS AND CORRECT COLUMNS
-- Migration: 158e (UPDATED)
-- Date: 2026-01-28
-- Description: 
--   CRITICAL FIXES APPLIED:
--   1. ✅ ADVISORY LOCK PROTECTION - Prevents double charges from race conditions
--   2. ✅ Correct wallet_ledger column names (available_delta, escrow_delta, pending_withdrawal_delta)
--   3. ✅ All transaction types supported (gift_purchase, gift_conversion, escrow_release_to_platform)
--   4. ✅ Proper delta variable initialization for all transaction types
--   5. ✅ UUID casting in idempotency check and INSERT statement
--   6. ✅ Balance validation includes gift_purchase
--
--   This migration combines:
--   - Advisory lock protection from migration 150-155 (prevents concurrent duplicate transactions)
--   - Column name fixes (uses correct wallet_ledger schema)
--   - All missing transaction types
-- =====================================================

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
  -- Wallet balance variables
  v_current_available NUMERIC;
  v_current_escrow NUMERIC;
  v_current_pending NUMERIC;
  v_new_available NUMERIC;
  v_new_escrow NUMERIC;
  v_new_pending NUMERIC;
  
  -- Transaction delta variables
  v_available_delta NUMERIC;
  v_escrow_delta NUMERIC;
  v_pending_delta NUMERIC;
  
  -- Sales tracking variables
  v_current_vendor_sales NUMERIC DEFAULT 0;
  v_current_rider_earnings NUMERIC DEFAULT 0;
  v_current_lifetime_revenue NUMERIC DEFAULT 0;
  v_new_vendor_sales NUMERIC;
  v_new_rider_earnings NUMERIC;
  v_new_lifetime_revenue NUMERIC;
  
  -- Transaction record
  v_transaction_id UUID;
  v_wallet_id UUID;
  
  -- Idempotency check
  v_existing_id UUID;
  v_lock_key BIGINT; -- Advisory lock key for preventing concurrent duplicate processing
BEGIN
  -- Get user's wallet
  SELECT id, available_balance, escrow_balance, pending_withdrawal, 
         total_vendor_sales, total_rider_earnings, lifetime_revenue
  INTO v_wallet_id, v_current_available, v_current_escrow, v_current_pending,
       v_current_vendor_sales, v_current_rider_earnings, v_current_lifetime_revenue
  FROM wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  -- Check if wallet exists
  IF v_wallet_id IS NULL THEN
    RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, 0::NUMERIC, 0::NUMERIC, 0::NUMERIC, 'Wallet not found for user'::TEXT;
    RETURN;
  END IF;

  -- ✅ CRITICAL: IDEMPOTENCY CHECK WITH ADVISORY LOCK (prevents race conditions and double charges)
  -- Industry standard: Use advisory locks to prevent concurrent processing of same reference
  IF p_reference_id IS NOT NULL AND p_reference_id != '' AND p_reference_type IS NOT NULL THEN
    -- Generate advisory lock key from reference parameters
    -- This ensures only one transaction with same reference can proceed at a time
    v_lock_key := abs(hashtext(p_user_id::TEXT || p_transaction_type || p_reference_type || p_reference_id));
    
    -- Acquire advisory lock (blocks until lock is available, releases on commit/rollback)
    -- This prevents concurrent processing of same reference even if no ledger row exists yet
    PERFORM pg_advisory_xact_lock(v_lock_key);
  END IF;
  
  -- Now check for existing transaction (with advisory lock held if applicable)
  SELECT id INTO v_existing_id
  FROM wallet_ledger
  WHERE user_id = p_user_id
    AND transaction_type = p_transaction_type
    AND reference_id = p_reference_id::UUID
    AND reference_type = p_reference_type
    AND created_at > NOW() - INTERVAL '1 hour'
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    -- Return existing transaction details
    SELECT available_balance, escrow_balance, pending_withdrawal
    INTO v_current_available, v_current_escrow, v_current_pending
    FROM wallets
    WHERE user_id = p_user_id;
    
    RETURN QUERY SELECT TRUE::BOOLEAN, v_existing_id, v_current_available, v_current_escrow, v_current_pending, 'Idempotent: transaction already processed'::TEXT;
    RETURN;
  END IF;

  -- Initialize sales tracking variables
  v_new_vendor_sales := v_current_vendor_sales;
  v_new_rider_earnings := v_current_rider_earnings;
  v_new_lifetime_revenue := v_current_lifetime_revenue;

  -- 2. Calculate deltas based on transaction type
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

    WHEN 'escrow_release_to_platform' THEN
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

  -- 3. Validate sufficient balance for debit operations
  IF p_transaction_type IN ('purchase_hold', 'withdrawal_burn', 'fee_deduction', 'gift_purchase', 'withdrawal_request') THEN
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

  -- 4. Update wallet balances
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

  -- 5. Create transaction record - 🔧 FIXED: Use correct column names that exist in table
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
    description,
    created_at,
    created_by
  )
  VALUES (
    gen_random_uuid(),
    v_wallet_id,
    p_user_id,
    p_transaction_type,
    v_available_delta,
    v_escrow_delta,
    v_pending_delta,
    v_new_available,
    v_new_escrow,
    v_new_pending,
    p_reference_type,
    p_reference_id::UUID,
    p_description,
    NOW(),
    p_user_id
  )
  RETURNING id INTO v_transaction_id;

  -- 6. Create sales ledger entry for vendor sales
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

  -- 7. Return success
  RETURN QUERY SELECT TRUE::BOOLEAN, v_transaction_id, v_new_available, v_new_escrow, v_new_pending, NULL::TEXT;

EXCEPTION
  WHEN OTHERS THEN
    -- Log error and return failure
    RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, v_current_available, v_current_escrow, v_current_pending, 
                   SQLERRM::TEXT;
END;
$$;
