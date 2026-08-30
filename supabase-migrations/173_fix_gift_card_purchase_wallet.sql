-- =====================================================
-- Migration: 173
-- Fix: Add gift_card_purchase support to process_wallet_transaction
-- Description:
--   The gift card purchase flow was falling into the ELSE branch of
--   process_wallet_transaction because 'gift_card_purchase' was not a
--   known case. The ELSE branch also had a malformed RETURN QUERY that
--   was missing the `idempotent` column, causing the cryptic Postgres
--   error "structure of query does not match function result type".
--
--   This migration:
--   1. Adds a WHEN 'gift_card_purchase' branch (debits available balance)
--   2. Adds 'gift_card_purchase' to the sufficient-balance check
--   3. Fixes the ELSE branch to return all 7 columns declared by RETURNS TABLE
-- =====================================================

BEGIN;

DROP FUNCTION IF EXISTS process_wallet_transaction(p_user_id UUID, p_transaction_type TEXT, p_amount NUMERIC, p_description TEXT, p_reference_id TEXT, p_reference_type TEXT);

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
  v_wallet_id UUID;
  v_current_available NUMERIC;
  v_current_escrow NUMERIC;
  v_current_pending NUMERIC;
  v_new_available NUMERIC;
  v_new_escrow NUMERIC;
  v_new_pending NUMERIC;
  v_available_delta NUMERIC := 0;
  v_escrow_delta NUMERIC := 0;
  v_pending_delta NUMERIC := 0;
  v_current_vendor_sales NUMERIC DEFAULT 0;
  v_current_rider_earnings NUMERIC DEFAULT 0;
  v_current_lifetime_revenue NUMERIC DEFAULT 0;
  v_new_vendor_sales NUMERIC;
  v_new_rider_earnings NUMERIC;
  v_new_lifetime_revenue NUMERIC;
  v_transaction_id UUID;
  v_reference_id_uuid UUID;
  v_amount NUMERIC;
  v_existing_transaction_id UUID;
  v_lock_key BIGINT;
BEGIN
  v_amount := ABS(p_amount);
  IF p_reference_id IS NULL OR p_reference_id = '' THEN
    v_reference_id_uuid := NULL;
  ELSIF p_reference_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    BEGIN
      v_reference_id_uuid := p_reference_id::UUID;
    EXCEPTION WHEN OTHERS THEN
      v_reference_id_uuid := NULL;
    END;
  ELSE
    v_reference_id_uuid := NULL;
  END IF;

  SELECT id, available_balance, escrow_balance, pending_withdrawal,
         total_vendor_sales, total_rider_earnings, lifetime_revenue
  INTO v_wallet_id, v_current_available, v_current_escrow, v_current_pending,
       v_current_vendor_sales, v_current_rider_earnings, v_current_lifetime_revenue
  FROM wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_wallet_id IS NULL THEN
    INSERT INTO wallets (user_id, available_balance, escrow_balance, pending_withdrawal, preferred_currency, kyc_status)
    VALUES (p_user_id, 0, 0, 0, 'USD', 'pending')
    RETURNING id, available_balance, escrow_balance, pending_withdrawal,
             COALESCE(total_vendor_sales, 0), COALESCE(total_rider_earnings, 0), COALESCE(lifetime_revenue, 0)
    INTO v_wallet_id, v_current_available, v_current_escrow, v_current_pending,
         v_current_vendor_sales, v_current_rider_earnings, v_current_lifetime_revenue;
  END IF;

  IF p_reference_id IS NOT NULL AND p_reference_id != '' AND p_reference_type IS NOT NULL THEN
    v_lock_key := abs(hashtext(p_user_id::TEXT || p_transaction_type || p_reference_type || p_reference_id));
    PERFORM pg_advisory_xact_lock(v_lock_key);

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

    IF v_existing_transaction_id IS NOT NULL THEN
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

      RETURN QUERY SELECT TRUE::BOOLEAN, v_existing_transaction_id, v_new_available, v_new_escrow, v_new_pending, 'Idempotent: transaction already processed'::TEXT, TRUE::BOOLEAN;
      RETURN;
    END IF;
  END IF;

  v_new_vendor_sales := v_current_vendor_sales;
  v_new_rider_earnings := v_current_rider_earnings;
  v_new_lifetime_revenue := v_current_lifetime_revenue;

  CASE p_transaction_type
    WHEN 'deposit_mint', 'reward_credit', 'admin_adjustment' THEN
      v_available_delta := v_amount;
      v_new_available := v_current_available + v_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    WHEN 'escrow_release' THEN
      v_available_delta := v_amount;
      v_new_available := v_current_available + v_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;
      v_new_vendor_sales := v_current_vendor_sales + v_amount;
      v_new_lifetime_revenue := v_current_lifetime_revenue + v_amount;

    WHEN 'delivery_payment' THEN
      v_available_delta := v_amount;
      v_new_available := v_current_available + v_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;
      v_new_rider_earnings := v_current_rider_earnings + v_amount;
      v_new_lifetime_revenue := v_current_lifetime_revenue + v_amount;

    WHEN 'purchase_hold' THEN
      v_available_delta := -v_amount;
      v_escrow_delta := v_amount;
      v_new_available := v_current_available - v_amount;
      v_new_escrow := v_current_escrow + v_amount;
      v_new_pending := v_current_pending;

    WHEN 'escrow_refund' THEN
      v_escrow_delta := -v_amount;
      v_available_delta := v_amount;
      v_new_escrow := v_current_escrow - v_amount;
      v_new_available := v_current_available + v_amount;
      v_new_pending := v_current_pending;

    WHEN 'withdrawal_burn', 'fee_deduction' THEN
      v_available_delta := -v_amount;
      v_new_available := v_current_available - v_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    WHEN 'withdrawal_request' THEN
      v_available_delta := -v_amount;
      v_pending_delta := v_amount;
      v_new_available := v_current_available - v_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending + v_amount;

    WHEN 'platform_commission' THEN
      v_available_delta := v_amount;
      v_escrow_delta := 0;
      v_new_available := v_current_available + v_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    WHEN 'gift_purchase' THEN
      v_available_delta := -v_amount;
      v_new_available := v_current_available - v_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    WHEN 'gift_card_purchase' THEN
      v_available_delta := -v_amount;
      v_new_available := v_current_available - v_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    WHEN 'gift_conversion' THEN
      IF p_amount < 0 THEN
        v_available_delta := -v_amount;
        v_new_available := v_current_available - v_amount;
      ELSE
        v_available_delta := v_amount;
        v_new_available := v_current_available + v_amount;
      END IF;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    WHEN 'escrow_release_to_platform' THEN
      v_escrow_delta := -v_amount;
      v_new_available := v_current_available;
      v_new_escrow := v_current_escrow - v_amount;
      v_new_pending := v_current_pending;

    ELSE
      RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, v_current_available, v_current_escrow, v_current_pending,
                     ('Unknown transaction type: ' || p_transaction_type)::TEXT, FALSE::BOOLEAN;
      RETURN;
  END CASE;

  IF p_transaction_type IN ('purchase_hold', 'withdrawal_burn', 'fee_deduction', 'withdrawal_request', 'gift_purchase', 'gift_card_purchase') THEN
    IF v_current_available < ABS(v_available_delta) THEN
      RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, v_current_available, v_current_escrow, v_current_pending,
                     'Insufficient available balance'::TEXT, FALSE::BOOLEAN;
      RETURN;
    END IF;
  END IF;

  IF p_transaction_type = 'escrow_refund' THEN
    IF v_current_escrow < ABS(v_escrow_delta) THEN
      RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, v_current_available, v_current_escrow, v_current_pending,
                     'Insufficient escrow balance'::TEXT, FALSE::BOOLEAN;
      RETURN;
    END IF;
  END IF;

  IF p_transaction_type = 'escrow_release_to_platform' THEN
    IF v_current_escrow < ABS(v_escrow_delta) THEN
      RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, v_current_available, v_current_escrow, v_current_pending,
                     'Insufficient escrow balance for platform release'::TEXT, FALSE::BOOLEAN;
      RETURN;
    END IF;
  END IF;

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

      RETURN QUERY SELECT TRUE::BOOLEAN, v_transaction_id, v_new_available, v_new_escrow, v_new_pending,
                     'Idempotent: transaction already exists (caught by unique constraint)'::TEXT, TRUE::BOOLEAN;
      RETURN;
  END;

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

  RETURN QUERY SELECT TRUE::BOOLEAN, v_transaction_id, v_new_available, v_new_escrow, v_new_pending, NULL::TEXT, FALSE::BOOLEAN;

EXCEPTION
  WHEN OTHERS THEN
    RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, v_current_available, v_current_escrow, v_current_pending,
                   SQLERRM::TEXT, FALSE::BOOLEAN;
END;
$$;

GRANT EXECUTE ON FUNCTION process_wallet_transaction(UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION process_wallet_transaction(UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT) TO service_role;

COMMIT;
