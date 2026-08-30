-- =====================================================
-- Migration: 176
-- Fix: Back gift card payments with a real reserve (marketing wallet) and
--      hold gift-card funds in the buyer's escrow balance, so vendor/rider/
--      platform payouts are correctly funded when a gift card is used.
--
-- Background:
--   Previously, gift card purchases debited the buyer's wallet but never
--   credited any reserve. Gift card redemptions at checkout only decremented
--   gift_cards.current_balance without moving any real money, so the escrow
--   created for the order only covered the wallet portion of the total (or
--   no escrow at all if the order was fully paid by gift card). This meant
--   vendors could be underpaid or not paid at all for gift-card-funded
--   orders.
--
-- Fix:
--   1. 'gift_card_purchase' becomes a signed transaction type (like
--      'gift_conversion'): negative = debit, positive = credit. This lets
--      it also be used to credit the marketing wallet (the gift card
--      reserve) when a card is purchased or a redemption is reverted.
--   2. New 'gift_card_escrow_hold' transaction type: a signed, escrow-only
--      balance delta for the buyer's wallet. Used to hold the reserve funds
--      released from the marketing wallet in the buyer's escrow_balance at
--      checkout (positive), and to release that hold on revert/refund
--      (negative).
--   3. The insufficient-balance check for existing debit-oriented types is
--      relaxed to only apply when the resulting delta is actually negative,
--      so 'gift_card_purchase' can also be used as a credit without being
--      incorrectly blocked by the available-balance check.
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
      -- ✅ FIX (176): now signed like gift_conversion. Negative = debit
      -- (buyer purchase, admin gift card creation, marketing wallet
      -- redemption debit). Positive = credit (marketing wallet reserve
      -- funding on purchase, or reserve restoration on revert/refund).
      IF p_amount < 0 THEN
        v_available_delta := -v_amount;
        v_new_available := v_current_available - v_amount;
      ELSE
        v_available_delta := v_amount;
        v_new_available := v_current_available + v_amount;
      END IF;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    WHEN 'gift_card_escrow_hold' THEN
      -- ✅ NEW (176): signed, escrow-only delta for the buyer's wallet.
      -- Positive = hold gift card reserve funds in buyer's escrow at
      -- checkout. Negative = release the hold (revert/refund).
      IF p_amount < 0 THEN
        v_escrow_delta := -v_amount;
        v_new_escrow := v_current_escrow - v_amount;
      ELSE
        v_escrow_delta := v_amount;
        v_new_escrow := v_current_escrow + v_amount;
      END IF;
      v_new_available := v_current_available;
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

  -- ✅ FIX (176): only enforce the available-balance check when the delta is
  -- actually negative (a real debit). 'gift_card_purchase' can now also be
  -- used as a credit (positive delta), which must never be blocked here.
  IF p_transaction_type IN ('purchase_hold', 'withdrawal_burn', 'fee_deduction', 'withdrawal_request', 'gift_purchase', 'gift_card_purchase') THEN
    IF v_available_delta < 0 AND v_current_available < ABS(v_available_delta) THEN
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

  -- ✅ NEW (176): only enforce the escrow-balance check for gift_card_escrow_hold
  -- when the delta is negative (releasing/reversing a hold).
  IF p_transaction_type = 'gift_card_escrow_hold' AND v_escrow_delta < 0 THEN
    IF v_current_escrow < ABS(v_escrow_delta) THEN
      RETURN QUERY SELECT FALSE::BOOLEAN, NULL::UUID, v_current_available, v_current_escrow, v_current_pending,
                     'Insufficient escrow balance for gift card hold reversal'::TEXT, FALSE::BOOLEAN;
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

-- Add 'gift_card_escrow_hold' to the wallet_ledger transaction_type CHECK constraint
ALTER TABLE wallet_ledger
  DROP CONSTRAINT IF EXISTS wallet_ledger_transaction_type_check;

ALTER TABLE wallet_ledger
  ADD CONSTRAINT wallet_ledger_transaction_type_check
  CHECK (transaction_type IN (
    -- Credits
    'deposit_mint',
    'escrow_release',
    'escrow_refund',
    'reward_credit',
    'admin_adjustment',
    'delivery_payment',
    'platform_commission',
    'gift_conversion',
    -- Debits
    'withdrawal_burn',
    'fee_deduction',
    'gift_purchase',
    'gift_card_purchase',
    -- Transfers
    'purchase_hold',
    'withdrawal_request',
    'escrow_release_to_platform',
    'gift_card_escrow_hold'
  ));

COMMIT;
