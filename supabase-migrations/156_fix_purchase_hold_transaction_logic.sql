-- =====================================================
-- FIX PURCHASE_HOLD TRANSACTION LOGIC - CRITICAL BUG FIX
-- Migration: 156
-- Date: 2026-01-28
-- Description: 
--   CRITICAL FIX: Correct the purchase_hold transaction logic that was
--   incorrectly adding funds to user's available balance instead of
--   moving funds from available to escrow.
--
--   Bug: In migration 155, purchase_hold was doing:
--     v_available_delta := p_amount;    -- WRONG: Added to available
--     v_escrow_delta := ABS(p_amount);  -- WRONG: Added to escrow
--
--   Fix: Correct purchase_hold to properly:
--     v_available_delta := -p_amount;    -- Debit from available
--     v_escrow_delta := p_amount;      -- Credit to escrow
--
--   This was causing users to receive free money instead of funds
--   being moved to escrow during checkout.
-- =====================================================

-- Drop the existing function to recreate with fixed logic
DROP FUNCTION IF EXISTS process_wallet_transaction(UUID, TEXT, DECIMAL, TEXT, TEXT, TEXT);

-- Recreate the function with corrected purchase_hold logic
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
  IF p_reference_id IS NOT NULL AND p_reference_id != '' AND p_reference_type IS NOT NULL THEN
    -- Generate advisory lock key from reference parameters
    v_lock_key := abs(hashtext(p_user_id::TEXT || p_transaction_type || p_reference_type || p_reference_id));
    
    -- Acquire advisory lock (blocks until lock is available, releases on commit/rollback)
    PERFORM pg_advisory_lock(v_lock_key);
    
    -- Check for existing transaction with same reference
    SELECT id INTO v_existing_transaction_id
    FROM wallet_ledger
    WHERE user_id = p_user_id
      AND transaction_type = p_transaction_type
      AND reference_type = p_reference_type
      AND reference_id = v_reference_id_uuid
    LIMIT 1;
    
    IF v_existing_transaction_id IS NOT NULL THEN
      -- Transaction already exists, return it (idempotent)
      PERFORM pg_advisory_unlock(v_lock_key);
      
      SELECT jsonb_build_object(
        'success', true,
        'transaction_id', v_existing_transaction_id,
        'idempotent', true,
        'message', 'Transaction already processed'
      ) INTO v_existing_transaction;
      
      RETURN v_existing_transaction;
    END IF;
  END IF;

  -- ✅ STEP 5: Calculate deltas based on transaction type
  -- Initialize deltas
  v_available_delta := 0;
  v_escrow_delta := 0;
  v_pending_delta := 0;

  CASE p_transaction_type
    WHEN 'deposit_mint' THEN
      v_available_delta := p_amount;
    WHEN 'withdrawal_burn' THEN
      v_available_delta := p_amount; -- negative amount
    -- ✅ CRITICAL FIX: Correct purchase_hold logic
    WHEN 'purchase_hold' THEN
      v_available_delta := -p_amount;    -- ✅ FIXED: Debit from available (negative)
      v_escrow_delta := p_amount;        -- ✅ FIXED: Credit to escrow (positive)
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
      -- Fetch the existing transaction and return it (idempotent)
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
      
      -- Release advisory lock if we have one
      IF p_reference_id IS NOT NULL AND p_reference_id != '' AND p_reference_type IS NOT NULL THEN
        PERFORM pg_advisory_unlock(v_lock_key);
      END IF;
      
      -- Return existing transaction (idempotent)
      SELECT jsonb_build_object(
        'success', true,
        'transaction_id', v_transaction_id,
        'idempotent', true,
        'message', 'Transaction already processed (found via unique constraint)'
      ) INTO v_existing_transaction;
      
      RETURN v_existing_transaction;
  END;

  -- ✅ STEP 8: Update wallet balances
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

  -- ✅ STEP 9: Create sales ledger entry (if applicable)
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

  -- ✅ STEP 10: Release advisory lock if we have one
  IF p_reference_id IS NOT NULL AND p_reference_id != '' AND p_reference_type IS NOT NULL THEN
    PERFORM pg_advisory_unlock(v_lock_key);
  END IF;

  -- ✅ STEP 11: Return success response
  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'wallet_id', v_wallet_id,
    'previous_available', v_current_available,
    'new_available', v_new_available,
    'previous_escrow', v_current_escrow,
    'new_escrow', v_new_escrow,
    'available_delta', v_available_delta,
    'escrow_delta', v_escrow_delta,
    'pending_delta', v_pending_delta
  );

EXCEPTION
  WHEN OTHERS THEN
    -- Release advisory lock if we have one
    IF p_reference_id IS NOT NULL AND p_reference_id != '' AND p_reference_type IS NOT NULL THEN
      PERFORM pg_advisory_unlock(v_lock_key);
    END IF;
    
    -- Log error and return failure
    RAISE WARNING 'process_wallet_transaction failed: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION process_wallet_transaction(UUID, TEXT, DECIMAL, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION process_wallet_transaction(UUID, TEXT, DECIMAL, TEXT, TEXT, TEXT) TO service_role;

-- Add comment explaining the fix
COMMENT ON FUNCTION process_wallet_transaction IS 
'Processes wallet transactions atomically with row-level locking.
INCLUDES IDEMPOTENCY CHECKING WITH PROPER LOCKING ORDER.
Fixed: Converts escrow_release -> vendor_sale and delivery_payment -> rider_delivery 
when inserting into sales_ledger to match the check constraint.
Note: platform_commission is NOT tracked in sales_ledger (it is commission income, not a sale).

CRITICAL FIX (Migration 156): Corrected purchase_hold logic to properly move funds 
from available_balance to escrow_balance instead of incorrectly adding to both.
Previous bug: v_available_delta := p_amount (added funds to available)
Fixed: v_available_delta := -p_amount (debits from available)';

-- =====================================================
-- VERIFICATION
-- =====================================================

-- Test the corrected purchase_hold logic (optional - comment out if not needed)
-- SELECT process_wallet_transaction(
--   p_user_id := 'your-test-user-id-here'::UUID,
--   p_transaction_type := 'purchase_hold',
--   p_amount := 15.63,
--   p_description := 'Test purchase hold - should move from available to escrow',
--   p_reference_id := 'test-order-id'::TEXT,
--   p_reference_type := 'order'
-- );
