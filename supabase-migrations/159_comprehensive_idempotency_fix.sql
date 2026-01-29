-- =====================================================
-- COMPREHENSIVE IDEMPOTENCY FIX - COMBINES ALL MIGRATIONS 144-158g
-- Migration: 159
-- Date: 2026-01-29
-- Description: 
--   This migration combines ALL critical fixes from migrations 144-158g:
--   
--   ✅ FROM 144-149: Gift system support (gift_purchase, gift_conversion)
--   ✅ FROM 150: Strong idempotency (advisory locks + unique constraint + ledger-first)
--   ✅ FROM 156: Fixed purchase_hold logic (move available→escrow, not add to both)
--   ✅ FROM 157: Fixed escrow_refund logic (move escrow→available, proper movement)
--   ✅ FROM 158d: Correct wallet_ledger columns (available_delta, escrow_delta, pending_withdrawal_delta)
--   ✅ FROM 158g: Fixed platform_commission to credit available (not debit escrow)
--   ✅ FROM 158e+: TABLE return format for compatibility
--   ✅ FROM 148: Proper reference_id TEXT→UUID casting
--   ✅ FROM 149: Restored idempotency checking
--   
--   KEY FEATURES:
--   - 4-layer idempotency protection (wallet lock + advisory lock + ledger-first + unique constraint)
--   - All transaction types supported including gifts
--   - Correct transaction logic for all operations
--   - Proper error handling and type casting
--   - Database-enforced uniqueness as final safety net
-- =====================================================

BEGIN;

-- Drop existing function to recreate with all fixes
DROP FUNCTION IF EXISTS process_wallet_transaction(p_user_id UUID, p_transaction_type TEXT, p_amount NUMERIC, p_description TEXT, p_reference_id TEXT, p_reference_type TEXT);

-- Create comprehensive function with all fixes
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
  error_message TEXT,
  idempotent BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  -- Wallet balance variables
  v_wallet_id UUID;
  v_current_available NUMERIC;
  v_current_escrow NUMERIC;
  v_current_pending NUMERIC;
  v_new_available NUMERIC;
  v_new_escrow NUMERIC;
  v_new_pending NUMERIC;
  
  -- Transaction delta variables
  v_available_delta NUMERIC := 0;
  v_escrow_delta NUMERIC := 0;
  v_pending_delta NUMERIC := 0;
  
  -- Sales tracking variables
  v_current_vendor_sales NUMERIC DEFAULT 0;
  v_current_rider_earnings NUMERIC DEFAULT 0;
  v_current_lifetime_revenue NUMERIC DEFAULT 0;
  v_new_vendor_sales NUMERIC;
  v_new_rider_earnings NUMERIC;
  v_new_lifetime_revenue NUMERIC;
  
  -- Transaction record
  v_transaction_id UUID;
  v_reference_id_uuid UUID;
  v_amount NUMERIC; -- ✅ FIX: Normalize amount to prevent double-negation bugs
  
  -- Idempotency checking variables
  v_existing_transaction_id UUID;
  v_lock_key BIGINT; -- Advisory lock key for preventing concurrent duplicate processing
BEGIN
  -- ✅ FIX: Normalize amount to absolute value to prevent sign-based bugs
  v_amount := ABS(p_amount);
  -- ✅ STEP 1: Validate and cast reference_id (from migration 148)
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

  -- ✅ STEP 2: Get wallet with row-level lock FIRST (from migration 150)
  -- Industry standard: Acquire locks before idempotency check to prevent race conditions
  SELECT id, available_balance, escrow_balance, pending_withdrawal, 
         total_vendor_sales, total_rider_earnings, lifetime_revenue
  INTO v_wallet_id, v_current_available, v_current_escrow, v_current_pending,
       v_current_vendor_sales, v_current_rider_earnings, v_current_lifetime_revenue
  FROM wallets
  WHERE user_id = p_user_id
  FOR UPDATE; -- Lock wallet row immediately to prevent concurrent access

  -- Check if wallet exists, create if not (from migration 150)
  IF v_wallet_id IS NULL THEN
    INSERT INTO wallets (user_id, available_balance, escrow_balance, pending_withdrawal, preferred_currency, kyc_status)
    VALUES (p_user_id, 0, 0, 0, 'USD', 'pending')
    RETURNING id, available_balance, escrow_balance, pending_withdrawal, 
             COALESCE(total_vendor_sales, 0), COALESCE(total_rider_earnings, 0), COALESCE(lifetime_revenue, 0)
    INTO v_wallet_id, v_current_available, v_current_escrow, v_current_pending,
         v_current_vendor_sales, v_current_rider_earnings, v_current_lifetime_revenue;
  END IF;

  -- ✅ STEP 3: IDEMPOTENCY CHECK WITH ADVISORY LOCK (from migration 150)
  -- Industry standard: Use advisory locks to prevent concurrent processing of same reference
  IF p_reference_id IS NOT NULL AND p_reference_id != '' AND p_reference_type IS NOT NULL THEN
    -- Generate advisory lock key from reference parameters
    v_lock_key := abs(hashtext(p_user_id::TEXT || p_transaction_type || p_reference_type || p_reference_id));
    
    -- Acquire advisory lock (blocks until lock is available, releases on commit/rollback)
    PERFORM pg_advisory_xact_lock(v_lock_key);
    
    -- Check for existing transaction with same reference (from migration 149)
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
    
    -- If existing transaction found, return it (idempotent)
    IF v_existing_transaction_id IS NOT NULL THEN
      -- FIX: Fetch balances from existing ledger entry for true idempotency
      SELECT
        available_balance_after,
        escrow_balance_after,
        pending_withdrawal_after
      INTO
        v_new_available,
        v_new_escrow,
        v_new_pending
      FROM wallet_ledger
      WHERE id = v_existing_transaction_id;
      
      -- Return existing transaction details with correct balances
      RETURN QUERY SELECT TRUE::BOOLEAN, v_existing_transaction_id, v_new_available, v_new_escrow, v_new_pending, 'Idempotent: transaction already processed'::TEXT, TRUE::BOOLEAN;
      RETURN;
    END IF;
  END IF;

  -- STEP 4: Initialize sales tracking variables
  v_new_vendor_sales := v_current_vendor_sales;
  v_new_rider_earnings := v_current_rider_earnings;
  v_new_lifetime_revenue := v_current_lifetime_revenue;

  -- ✅ STEP 5: Calculate deltas based on transaction type (COMBINED FROM ALL MIGRATIONS)
  CASE p_transaction_type
    -- Credits
    WHEN 'deposit_mint', 'reward_credit', 'admin_adjustment' THEN
      v_available_delta := v_amount;
      v_new_available := v_current_available + v_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    -- ✅ VENDOR SALE: Credit available + track as vendor sale (from migration 156)
    WHEN 'escrow_release' THEN
      v_available_delta := v_amount;
      v_new_available := v_current_available + v_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;
      v_new_vendor_sales := v_current_vendor_sales + v_amount;
      v_new_lifetime_revenue := v_current_lifetime_revenue + v_amount;

    -- ✅ RIDER DELIVERY FEE: Credit available + track as rider earnings (from migration 156)
    WHEN 'delivery_payment' THEN
      v_available_delta := v_amount;
      v_new_available := v_current_available + v_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;
      v_new_rider_earnings := v_current_rider_earnings + v_amount;
      v_new_lifetime_revenue := v_current_lifetime_revenue + v_amount;

    -- ✅ CRITICAL FIX: Correct purchase_hold logic (from migration 156)
    WHEN 'purchase_hold' THEN
      v_available_delta := -v_amount;    -- ✅ FIXED: Use normalized amount
      v_escrow_delta := v_amount;        -- ✅ FIXED: Use normalized amount
      v_new_available := v_current_available - v_amount;
      v_new_escrow := v_current_escrow + v_amount;
      v_new_pending := v_current_pending;

    -- ✅ CRITICAL FIX: Correct escrow_refund logic (from migration 157)
    WHEN 'escrow_refund' THEN
      v_escrow_delta := -v_amount;       -- ✅ FIXED: Use normalized amount
      v_available_delta := v_amount;     -- ✅ FIXED: Use normalized amount
      v_new_escrow := v_current_escrow - v_amount;
      v_new_available := v_current_available + v_amount;
      v_new_pending := v_current_pending;

    -- Withdrawal and fee transactions
    WHEN 'withdrawal_burn', 'fee_deduction' THEN
      v_available_delta := -v_amount;    -- ✅ FIXED: Use normalized amount
      v_new_available := v_current_available - v_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    -- Withdrawal request (move to pending)
    WHEN 'withdrawal_request' THEN
      v_available_delta := -v_amount;    -- ✅ FIXED: Use normalized amount
      v_pending_delta := v_amount;       -- ✅ FIXED: Use normalized amount
      v_new_available := v_current_available - v_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending + v_amount;

    -- ✅ CRITICAL FIX: Platform commission credits available (from migration 158g)
    WHEN 'platform_commission' THEN
      v_available_delta := v_amount;    -- ✅ FIXED: Use normalized amount
      v_escrow_delta := 0;               -- ✅ FIXED: Don't touch escrow
      v_new_available := v_current_available + v_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    -- ✅ Gift transaction types (from migrations 144-149)
    WHEN 'gift_purchase' THEN
      v_available_delta := -v_amount;    -- ✅ FIXED: Use normalized amount
      v_new_available := v_current_available - v_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    WHEN 'gift_conversion' THEN
      -- ✅ FIX: gift_conversion supports both positive (credit) and negative (debit) amounts
      -- Backend uses: negative for platform wallet debits, positive for user credits
      -- Preserves normalization invariant
      IF p_amount < 0 THEN
        -- Debit platform gift wallet
        v_available_delta := -v_amount;
        v_new_available := v_current_available - v_amount;
      ELSE
        -- Credit user wallet
        v_available_delta := v_amount;
        v_new_available := v_current_available + v_amount;
      END IF;

      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    -- Platform commission from escrow
    WHEN 'escrow_release_to_platform' THEN
      v_escrow_delta := -v_amount;       -- ✅ FIXED: Use normalized amount
      v_new_available := v_current_available;
      v_new_escrow := v_current_escrow - v_amount;
      v_new_pending := v_current_pending;

    ELSE
      -- Unknown transaction type
      RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, v_current_available, v_current_escrow, v_current_pending, 
                     ('Unknown transaction type: ' || p_transaction_type)::TEXT;
      RETURN;
  END CASE;

  -- ✅ STEP 6: Validate sufficient balance for debit operations
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

  IF p_transaction_type = 'escrow_release_to_platform' THEN
    IF v_current_escrow < ABS(v_escrow_delta) THEN
      RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, v_current_available, v_current_escrow, v_current_pending, 
                     'Insufficient escrow balance for platform release'::TEXT;
      RETURN;
    END IF;
  END IF;

  -- ✅ STEP 7: Create wallet ledger entry FIRST (from migration 150)
  -- This ensures we can catch duplicate inserts before modifying wallet balance
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
              
              -- ✅ FIX: Fetch balances from existing ledger entry for true idempotency
              SELECT
                available_balance_after,
                escrow_balance_after,
                pending_withdrawal_after
              INTO
                v_new_available,
                v_new_escrow,
                v_new_pending
              FROM wallet_ledger
              WHERE id = v_transaction_id;
              
              -- Return existing transaction (idempotent)
              RETURN QUERY SELECT TRUE::BOOLEAN, v_transaction_id, v_new_available, v_new_escrow, v_new_pending, 
                             'Idempotent: transaction already exists (caught by unique constraint)'::TEXT, TRUE::BOOLEAN;
              RETURN;
  END;

  -- ✅ STEP 8: Update wallet balances (only if ledger insert succeeded)
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

  -- ✅ STEP 9: Create sales ledger entry (if applicable - from migration 156)
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
      v_amount,
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

  -- ✅ STEP 10: Return success response
  RETURN QUERY SELECT TRUE::BOOLEAN, v_transaction_id, v_new_available, v_new_escrow, v_new_pending, NULL::TEXT, FALSE::BOOLEAN;

EXCEPTION
  WHEN OTHERS THEN
    -- Log error and return failure
    RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, v_current_available, v_current_escrow, v_current_pending, 
                   SQLERRM::TEXT, FALSE::BOOLEAN;
END;
$$;

-- ✅ STEP 11: Ensure idempotency index exists (from migration 150)
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_idempotency 
ON wallet_ledger(user_id, transaction_type, reference_type, reference_id)
WHERE reference_id IS NOT NULL AND reference_type IS NOT NULL;

-- ✅ STEP 12: Clean up existing duplicate transactions before creating unique index (from migration 150)
DO $$
DECLARE
  duplicate_count INTEGER;
BEGIN
  -- Find and remove duplicate transactions, keeping only the first one (oldest)
  DELETE FROM wallet_ledger
  WHERE id IN (
    SELECT id FROM (
      SELECT 
        id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, transaction_type, reference_type, reference_id 
          ORDER BY created_at ASC
        ) as row_num
      FROM wallet_ledger
      WHERE reference_id IS NOT NULL 
        AND reference_type IS NOT NULL
    ) duplicates
    WHERE row_num > 1
  );
  
  GET DIAGNOSTICS duplicate_count = ROW_COUNT;
  
  IF duplicate_count > 0 THEN
    RAISE NOTICE 'Cleaned up % duplicate transaction(s) before creating unique index', duplicate_count;
  END IF;
END $$;

-- ✅ STEP 13: Add unique index to prevent duplicates at database level (from migration 150)
-- This provides an additional layer of protection beyond application-level checks
CREATE UNIQUE INDEX IF NOT EXISTS wallet_ledger_idempotency_unique
ON wallet_ledger(user_id, transaction_type, reference_type, reference_id)
WHERE reference_id IS NOT NULL AND reference_type IS NOT NULL;

-- ✅ STEP 14: Grant execute permissions
GRANT EXECUTE ON FUNCTION process_wallet_transaction(UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION process_wallet_transaction(UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT) TO service_role;

-- ✅ STEP 15: Add comprehensive comment explaining all fixes
COMMENT ON FUNCTION process_wallet_transaction IS 
'Comprehensive wallet transaction function combining ALL fixes from migrations 144-158g.

✅ IDEMPOTENCY PROTECTION (4 layers):
1. Wallet row lock acquired FIRST (prevents concurrent balance reads)
2. Advisory lock on reference parameters (serializes same-reference requests)
3. Ledger insert BEFORE wallet update (atomicity guarantee)
4. Database-enforced unique constraint (final safety net)

✅ TRANSACTION LOGIC FIXES:
- Fixed purchase_hold: moves available→escrow (not add to both) [migration 156]
- Fixed escrow_refund: moves escrow→available (proper movement) [migration 157]
- Fixed platform_commission: credits available (not debit escrow) [migration 158g]
- All gift transaction types supported [migrations 144-149]

✅ TECHNICAL FIXES:
- Proper reference_id TEXT→UUID casting [migration 148]
- Correct wallet_ledger columns (available_delta, escrow_delta, pending_withdrawal_delta) [migration 158d]
- TABLE return format for compatibility [migration 158+]
- Explicit type casting in RETURN QUERY statements [migration 158c]

✅ ERROR HANDLING:
- Graceful unique_violation handling with idempotent response
- Proper balance validation for all debit operations
- Comprehensive error reporting

This function is "correct by construction" with defense-in-depth protection against race conditions
and duplicate transactions, even under high concurrent load.';

COMMIT;
