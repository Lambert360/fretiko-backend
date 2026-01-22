-- =====================================================
-- FIX SALES_LEDGER TRANSACTION_TYPE CONSTRAINT ERROR
-- Migration: 155
-- Date: 2026-01-22
-- Description: 
--   Fix sales_ledger transaction_type constraint violation.
--   The sales_ledger table only allows 'vendor_sale' and 'rider_delivery',
--   but the function was inserting 'escrow_release' and 'delivery_payment' directly.
--   This migration fixes the process_wallet_transaction function to convert
--   'escrow_release' -> 'vendor_sale' and 'delivery_payment' -> 'rider_delivery'.
--   Note: platform_commission is NOT tracked in sales_ledger (it's commission income, not a sale).
-- =====================================================

-- Drop all existing function signatures to avoid ambiguity
DROP FUNCTION IF EXISTS process_wallet_transaction(UUID, TEXT, DECIMAL, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS process_wallet_transaction;

-- Recreate the function with the fix (exact same signature as migration 150)
-- This is essentially migration 150 with the sales_ledger fix already applied
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
  v_new_available DECIMAL;
  v_new_escrow DECIMAL;
  v_new_pending DECIMAL;
  v_available_delta DECIMAL;
  v_escrow_delta DECIMAL;
  v_pending_delta DECIMAL;
  v_transaction_id UUID;
  v_new_vendor_sales DECIMAL;
  v_new_rider_earnings DECIMAL;
  v_new_lifetime_revenue DECIMAL;
  v_reference_id_uuid UUID;
  
  -- Idempotency checking variables
  v_existing_transaction_id UUID;
  v_existing_transaction JSONB;
  v_lock_key BIGINT; -- Advisory lock key for preventing concurrent duplicate processing
BEGIN
  -- ✅ STEP 1: Validate and cast reference_id (no locking yet, just validation)
  IF p_reference_id IS NULL OR p_reference_id = '' THEN
    v_reference_id_uuid := NULL;
  ELSIF p_reference_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    -- Valid UUID format, cast to UUID
    BEGIN
      v_reference_id_uuid := p_reference_id::UUID;
    EXCEPTION WHEN OTHERS THEN
      v_reference_id_uuid := NULL;
    END;
  ELSE
    -- Invalid UUID format, set to NULL
    v_reference_id_uuid := NULL;
  END IF;

  -- ✅ STEP 2: Get or create wallet (with row-level lock FIRST)
  -- Industry standard: Acquire locks before idempotency check to prevent race conditions
  SELECT id INTO v_wallet_id
  FROM wallets
  WHERE user_id = p_user_id
  FOR UPDATE; -- Lock wallet row immediately to prevent concurrent access

  IF v_wallet_id IS NULL THEN
    INSERT INTO wallets (user_id, available_balance, escrow_balance, pending_withdrawal, preferred_currency, kyc_status)
    VALUES (p_user_id, 0, 0, 0, 'USD', 'pending')
    RETURNING id INTO v_wallet_id;
  END IF;

  -- ✅ STEP 3: Get current balances (lock already held from above)
  SELECT available_balance, escrow_balance, pending_withdrawal,
         total_vendor_sales, total_rider_earnings, lifetime_revenue
  INTO v_current_available, v_current_escrow, v_current_pending,
       v_new_vendor_sales, v_new_rider_earnings, v_new_lifetime_revenue
  FROM wallets
  WHERE id = v_wallet_id;

  -- ✅ STEP 4: IDEMPOTENCY CHECK (WITH LOCKS HELD - prevents race conditions)
  -- Industry standard: Use advisory locks to prevent concurrent processing of same reference
  -- This works even when no ledger row exists yet (unlike SELECT FOR UPDATE)
  IF p_reference_id IS NOT NULL AND p_reference_id != '' AND p_reference_type IS NOT NULL THEN
    -- Generate advisory lock key from reference parameters
    -- This ensures only one transaction with same reference can proceed at a time
    -- Using hashtext to convert string combination to bigint for advisory lock
    v_lock_key := abs(hashtext(p_user_id::TEXT || p_transaction_type || p_reference_type || p_reference_id));
    
    -- Acquire advisory lock (blocks until lock is available, releases on commit/rollback)
    -- This prevents concurrent processing of same reference even if no ledger row exists yet
    PERFORM pg_advisory_xact_lock(v_lock_key);
    
    -- Now check for existing transaction (with advisory lock held)
    -- The lock ensures only one request can check at a time
    SELECT id INTO v_existing_transaction_id
    FROM wallet_ledger
    WHERE user_id = p_user_id
      AND transaction_type = p_transaction_type
      AND reference_type = p_reference_type
      AND (
        (v_reference_id_uuid IS NOT NULL AND reference_id = v_reference_id_uuid)
        OR (v_reference_id_uuid IS NULL AND reference_id::TEXT = p_reference_id)
      )
    ORDER BY created_at DESC
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

  -- ✅ STEP 5: Calculate new balances based on transaction type
  v_available_delta := 0;
  v_escrow_delta := 0;
  v_pending_delta := 0;

  CASE p_transaction_type
    WHEN 'deposit_mint' THEN
      v_available_delta := p_amount;
    WHEN 'withdrawal_burn' THEN
      v_available_delta := p_amount; -- negative amount
    WHEN 'purchase_hold' THEN
      v_available_delta := p_amount; -- negative amount
      v_escrow_delta := ABS(p_amount);
    WHEN 'escrow_release' THEN
      v_escrow_delta := p_amount; -- negative (debit escrow)
      v_available_delta := ABS(p_amount); -- credit available
      -- Track as vendor sale
      v_new_vendor_sales := COALESCE(v_new_vendor_sales, 0) + ABS(p_amount);
      v_new_lifetime_revenue := COALESCE(v_new_lifetime_revenue, 0) + ABS(p_amount);
    WHEN 'escrow_refund' THEN
      v_escrow_delta := p_amount; -- negative (debit escrow)
      v_available_delta := ABS(p_amount); -- credit available
    WHEN 'admin_adjustment' THEN
      v_available_delta := p_amount;
    WHEN 'fee_deduction' THEN
      v_available_delta := p_amount; -- negative amount
    WHEN 'reward_credit' THEN
      v_available_delta := p_amount;
    WHEN 'delivery_payment' THEN
      v_available_delta := p_amount;
      -- Track as rider earnings
      v_new_rider_earnings := COALESCE(v_new_rider_earnings, 0) + ABS(p_amount);
      v_new_lifetime_revenue := COALESCE(v_new_lifetime_revenue, 0) + ABS(p_amount);
    WHEN 'platform_commission' THEN
      v_available_delta := p_amount;
      -- Note: platform_commission is NOT tracked in sales_ledger (it's commission income, not a sale)
    WHEN 'withdrawal_request' THEN
      v_available_delta := p_amount; -- negative amount
      v_pending_delta := ABS(p_amount);
    WHEN 'escrow_release_to_platform' THEN
      v_escrow_delta := p_amount; -- negative (debit escrow)
    WHEN 'gift_purchase' THEN
      v_available_delta := p_amount; -- negative amount (debit)
    WHEN 'gift_conversion' THEN
      v_available_delta := p_amount; -- can be positive (credit) or negative (debit)
    ELSE
      RAISE EXCEPTION 'Invalid transaction type: %', p_transaction_type;
  END CASE;

  v_new_available := v_current_available + v_available_delta;
  v_new_escrow := v_current_escrow + v_escrow_delta;
  v_new_pending := v_current_pending + v_pending_delta;

  -- ✅ STEP 6: Validate balances
  IF v_new_available < 0 THEN
    RAISE EXCEPTION 'Insufficient available balance. Current: %, Required: %', v_current_available, ABS(v_available_delta);
  END IF;
  IF v_new_escrow < 0 THEN
    RAISE EXCEPTION 'Insufficient escrow balance. Current: %, Required: %', v_current_escrow, ABS(v_escrow_delta);
  END IF;
  IF v_new_pending < 0 THEN
    RAISE EXCEPTION 'Invalid pending withdrawal balance. Current: %, Delta: %', v_current_pending, v_pending_delta;
  END IF;

  -- ✅ STEP 7: Create wallet ledger entry FIRST (before updating wallet)
  -- This ensures we can catch duplicate inserts before modifying wallet balance
  -- If insert fails due to unique constraint, we return early without updating wallet
  BEGIN
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
  EXCEPTION
    WHEN unique_violation THEN
      -- Unique constraint violation - transaction already exists
      -- This means another request already processed this transaction
      -- Fetch the existing transaction and return it (idempotent response)
      SELECT id INTO v_transaction_id
      FROM wallet_ledger
      WHERE user_id = p_user_id
        AND transaction_type = p_transaction_type
        AND reference_type = p_reference_type
        AND (
          (v_reference_id_uuid IS NOT NULL AND reference_id = v_reference_id_uuid)
          OR (v_reference_id_uuid IS NULL AND reference_id::TEXT = p_reference_id)
        )
      ORDER BY created_at DESC
      LIMIT 1;
      
      -- Return existing transaction (idempotent)
      -- Wallet balance was NOT updated, so we return the existing transaction's balance
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
      WHERE id = v_transaction_id;
      
      RETURN COALESCE(v_existing_transaction, jsonb_build_object(
        'success', true,
        'transaction_id', v_transaction_id,
        'idempotent', true,
        'message', 'Transaction already exists (caught by unique constraint)'
      ));
  END;

  -- ✅ STEP 8: Update wallet balances (only if ledger insert succeeded)
  -- This happens AFTER the insert to ensure atomicity
  UPDATE wallets
  SET available_balance = v_new_available,
      escrow_balance = v_new_escrow,
      pending_withdrawal = v_new_pending,
      total_vendor_sales = COALESCE(v_new_vendor_sales, total_vendor_sales),
      total_rider_earnings = COALESCE(v_new_rider_earnings, total_rider_earnings),
      lifetime_revenue = COALESCE(v_new_lifetime_revenue, lifetime_revenue),
      updated_at = NOW()
  WHERE id = v_wallet_id;

  -- ✅ STEP 9: Create sales ledger entry (if applicable - only for escrow_release and delivery_payment)
  -- ✅ FIX: Convert transaction_type to match sales_ledger constraint ('vendor_sale' or 'rider_delivery')
  -- Note: platform_commission is NOT included here - it's commission income, not a sale
  IF p_transaction_type IN ('escrow_release', 'delivery_payment') THEN
    INSERT INTO sales_ledger (
      id, user_id, wallet_id, transaction_type, amount,
      order_id, escrow_id,
      vendor_sales_after, rider_earnings_after, lifetime_revenue_after,
      description, created_at, created_by
    ) VALUES (
      gen_random_uuid(), p_user_id, v_wallet_id, 
      CASE WHEN p_transaction_type = 'escrow_release' THEN 'vendor_sale' ELSE 'rider_delivery' END,
      ABS(p_amount),
      CASE WHEN p_reference_type = 'order' THEN v_reference_id_uuid ELSE NULL END,
      CASE WHEN p_reference_type = 'escrow' THEN v_reference_id_uuid ELSE NULL END,
      COALESCE(v_new_vendor_sales, 0),
      COALESCE(v_new_rider_earnings, 0),
      COALESCE(v_new_lifetime_revenue, 0),
      p_description,
      NOW(),
      p_user_id
    );
  END IF;

  -- ✅ STEP 10: Return transaction details
  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'wallet_id', v_wallet_id,
    'available_balance_after', v_new_available,
    'escrow_balance_after', v_new_escrow,
    'pending_withdrawal_after', v_new_pending,
    'idempotent', false
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION process_wallet_transaction IS 
'Processes wallet transactions atomically with row-level locking.
INCLUDES IDEMPOTENCY CHECKING WITH PROPER LOCKING ORDER.
Fixed: Converts escrow_release -> vendor_sale and delivery_payment -> rider_delivery 
when inserting into sales_ledger to match the check constraint.
Note: platform_commission is NOT tracked in sales_ledger (it is commission income, not a sale).';
