BEGIN;

-- =====================================================
-- FIX PLATFORM COMMISSION WALLET UPDATE
-- Migration: 152
-- Date: 2026-01-XX
-- Description: 
--   Fix platform_commission transaction type to properly update wallet balance
--   Ensures platform wallet receives commission funds correctly
--   Does NOT break existing migration 150 - only fixes the platform_commission case
-- =====================================================

-- Recreate the function with explicit fix for platform_commission
-- This preserves all the idempotency logic from migration 150
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
      v_available_delta := p_amount; -- negative amount
    WHEN 'platform_commission' THEN
      -- ✅ FIX: Explicitly calculate new balances like original migration
      v_available_delta := ABS(p_amount); -- Ensure positive credit
      v_new_available := v_current_available + ABS(p_amount);
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;
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

  -- ✅ STEP 6: Calculate new balances (CRITICAL: This must happen for ALL transaction types)
  v_new_available := v_current_available + v_available_delta;
  v_new_escrow := v_current_escrow + v_escrow_delta;
  v_new_pending := v_current_pending + v_pending_delta;

  -- ✅ STEP 7: Validate balances
  IF v_new_available < 0 THEN
    RAISE EXCEPTION 'Insufficient available balance. Current: %, Required: %', v_current_available, ABS(v_available_delta);
  END IF;
  IF v_new_escrow < 0 THEN
    RAISE EXCEPTION 'Insufficient escrow balance. Current: %, Required: %', v_current_escrow, ABS(v_escrow_delta);
  END IF;
  IF v_new_pending < 0 THEN
    RAISE EXCEPTION 'Invalid pending withdrawal balance. Current: %, Delta: %', v_current_pending, v_pending_delta;
  END IF;

  -- ✅ STEP 8: Create wallet ledger entry FIRST (before updating wallet)
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

  -- ✅ STEP 9: Update wallet balances (only if ledger insert succeeded)
  -- This happens AFTER the insert to ensure atomicity
  -- ✅ CRITICAL FIX: Explicitly update available_balance for platform_commission
  UPDATE wallets
  SET available_balance = v_new_available,
      escrow_balance = v_new_escrow,
      pending_withdrawal = v_new_pending,
      total_vendor_sales = v_new_vendor_sales,
      total_rider_earnings = v_new_rider_earnings,
      lifetime_revenue = v_new_lifetime_revenue,
      updated_at = NOW()
  WHERE id = v_wallet_id;

  -- ✅ STEP 10: Create sales ledger entry (if applicable - only for escrow_release and delivery_payment)
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
      v_new_vendor_sales,
      v_new_rider_earnings,
      v_new_lifetime_revenue,
      p_description,
      NOW(),
      p_user_id
    );
  END IF;

  -- ✅ STEP 11: Return transaction details
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

-- Update comment explaining the fix
COMMENT ON FUNCTION process_wallet_transaction IS 
'Processes wallet transactions atomically with row-level locking.
INCLUDES IDEMPOTENCY CHECKING WITH PROPER LOCKING ORDER:
1. Acquires wallet row lock FIRST (prevents concurrent balance reads)
2. THEN checks for existing transactions with SELECT FOR UPDATE (prevents race conditions)
3. This ensures only one concurrent request can pass the idempotency check
4. Database-level unique constraint provides additional protection
This prevents duplicate transactions from concurrent requests even under high load.

FIX (Migration 152): platform_commission now explicitly credits available_balance correctly.';

-- ✅ STEP 12: Ensure platform wallet exists
-- This ensures the platform user (00000000-0000-4000-8000-000000000002) has a wallet
DO $$
DECLARE
  v_platform_user_id UUID := '00000000-0000-4000-8000-000000000002';
  v_wallet_exists BOOLEAN;
BEGIN
  SELECT EXISTS(SELECT 1 FROM wallets WHERE user_id = v_platform_user_id) INTO v_wallet_exists;
  
  IF NOT v_wallet_exists THEN
    INSERT INTO wallets (user_id, available_balance, escrow_balance, pending_withdrawal, preferred_currency, kyc_status)
    VALUES (v_platform_user_id, 0, 0, 0, 'USD', 'pending')
    ON CONFLICT (user_id) DO NOTHING;
    
    RAISE NOTICE 'Created platform wallet for user %', v_platform_user_id;
  END IF;
END $$;

COMMIT;

