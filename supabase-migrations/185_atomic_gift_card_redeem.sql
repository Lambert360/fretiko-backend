-- =====================================================
-- Migration: 185
-- Add redeem_gift_card_atomic(): a single RPC that atomically
-- applies a gift card to a checkout / order.
--
-- Background (the bug this fixes):
--   gift-cards.service.ts applyToCheckout() currently does:
--     1. processWalletTransaction('gift_card_purchase', -appliedAmount)
--        on the admin/reserve wallet
--     2. processWalletTransaction('gift_card_escrow_hold', +appliedAmount)
--        on the buyer's escrow
--     3. UPDATE gift_cards SET current_balance = ..., status = ...
--     4. INSERT gift_card_transactions('redeem', ...)
--   Steps 3-4 happen after the wallet movements. If either fails
--   (or if a duplicate webhook/retry races between the wallet calls
--   and the card balance update), the reserve is already released
--   and the buyer's escrow is already held, but the card balance is
--   not decremented. The same card can then be applied again to
--   another order, producing a genuine double-spend.
--
-- What this migration does:
--   Adds redeem_gift_card_atomic(), which in one Postgres
--   transaction:
--     1. Locks the gift_cards row FOR UPDATE (serializes all
--       redemptions of the same card).
--     2. Validates the card, PIN, status, and expiry.
--     3. Guards against re-processing the same reservation_ref.
--     4. Debits the admin/reserve wallet for the applied amount.
--     5. Credits the buyer's escrow with the same amount.
--     6. Decrements the gift_cards current_balance and sets the
--       status to 'redeemed' (if fully consumed) or 'claimed'.
--     7. Inserts the gift_card_transactions audit row.
--   If any step fails, the entire transaction rolls back, so the
--   gift card can never be decremented without the matching escrow
--   hold, and the escrow hold can never be created without the
--   matching reserve debit.
--
--   This is additive only and does not modify the existing
--   process_wallet_transaction or gift card tables.
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION redeem_gift_card_atomic(
  p_card_number TEXT,
  p_pin TEXT,
  p_user_id UUID,
  p_admin_user_id UUID,
  p_applied_amount NUMERIC,
  p_order_id UUID DEFAULT NULL,
  p_user_ip TEXT DEFAULT NULL,
  p_reservation_ref TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_gift_card RECORD;
  v_reservation_ref TEXT;
  v_debit_result RECORD;
  v_hold_result RECORD;
  v_remaining_balance NUMERIC;
  v_new_status TEXT;
  v_transaction_type TEXT;
  v_already_processed RECORD;
BEGIN
  -- 1. Validate amount.
  IF p_applied_amount IS NULL OR p_applied_amount <= 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Applied amount must be positive',
      'error_code', 'INVALID_AMOUNT'
    );
  END IF;

  v_reservation_ref := COALESCE(p_reservation_ref, gen_random_uuid()::TEXT);

  -- 2. Lock the gift card row and validate it. The FOR UPDATE lock
  --    prevents concurrent redemptions of the same card.
  SELECT * INTO v_gift_card
  FROM gift_cards
  WHERE card_number = p_card_number
    AND pin = p_pin
    AND status IN ('active', 'claimed')
    AND (expires_at IS NULL OR expires_at > NOW())
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Invalid, expired, or already redeemed gift card',
      'error_code', 'INVALID_CARD'
    );
  END IF;

  IF v_gift_card.current_balance <= 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Gift card has no remaining balance',
      'error_code', 'ZERO_BALANCE'
    );
  END IF;

  IF p_applied_amount > v_gift_card.current_balance THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Applied amount %s exceeds card balance %s', p_applied_amount, v_gift_card.current_balance),
      'error_code', 'AMOUNT_EXCEEDS_BALANCE'
    );
  END IF;

  -- 3. Idempotency guard: if we already logged a transaction for this
  --    reservation ref, the whole operation was committed previously.
  SELECT id INTO v_already_processed
  FROM gift_card_transactions
  WHERE gift_card_id = v_gift_card.id
    AND metadata @> jsonb_build_object('reservation_ref', v_reservation_ref)
  LIMIT 1;

  IF FOUND THEN
    v_remaining_balance := v_gift_card.current_balance;
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'applied_amount', 0,
      'remaining_balance', v_remaining_balance,
      'gift_card_id', v_gift_card.id
    );
  END IF;

  v_remaining_balance := v_gift_card.current_balance - p_applied_amount;
  v_new_status := CASE WHEN v_remaining_balance = 0 THEN 'redeemed' ELSE 'claimed' END;
  v_transaction_type := CASE WHEN v_remaining_balance = 0 THEN 'redeem' ELSE 'partial_redeem' END;

  -- 4. Debit the admin/reserve wallet for the applied amount.
  SELECT * INTO v_debit_result
  FROM process_wallet_transaction(
    p_admin_user_id,
    'gift_card_purchase',
    -p_applied_amount,
    format('Gift card redemption reserve release (card ending %s)', RIGHT(p_card_number, 4)),
    v_reservation_ref,
    'gift_card_redeem'
  );

  IF NOT v_debit_result.success THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', v_debit_result.error_message,
      'error_code', 'RESERVE_DEBIT_FAILED'
    );
  END IF;

  -- 5. Hold the same amount in the buyer's escrow. Same transaction,
  --    so a failure here rolls back the reserve debit.
  SELECT * INTO v_hold_result
  FROM process_wallet_transaction(
    p_user_id,
    'gift_card_escrow_hold',
    p_applied_amount,
    'Gift card funds held for order payment',
    v_reservation_ref,
    'gift_card_redeem'
  );

  IF NOT v_hold_result.success THEN
    RAISE EXCEPTION 'Buyer escrow hold failed for gift card %: %', v_gift_card.id, v_hold_result.error_message;
  END IF;

  -- 6. Decrement the card balance and set status.
  UPDATE gift_cards
  SET
    current_balance = v_remaining_balance,
    status = v_new_status,
    last_used_at = NOW()
  WHERE id = v_gift_card.id;

  -- 7. Log the redeem/partial_redeem transaction.
  INSERT INTO gift_card_transactions (
    gift_card_id,
    transaction_type,
    amount,
    balance_after,
    order_id,
    user_id,
    user_ip,
    metadata
  )
  VALUES (
    v_gift_card.id,
    v_transaction_type,
    p_applied_amount,
    v_remaining_balance,
    p_order_id,
    p_user_id,
    p_user_ip,
    jsonb_build_object(
      'reservation_ref', v_reservation_ref,
      'reserve_debit_transaction_id', v_debit_result.transaction_id,
      'escrow_hold_transaction_id', v_hold_result.transaction_id,
      'order_id', p_order_id
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'applied_amount', p_applied_amount,
    'remaining_balance', v_remaining_balance,
    'gift_card_id', v_gift_card.id,
    'reservation_ref', v_reservation_ref,
    'reserve_transaction_id', v_debit_result.transaction_id,
    'escrow_hold_transaction_id', v_hold_result.transaction_id
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error in redeem_gift_card_atomic: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during gift card redemption',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION redeem_gift_card_atomic IS
'Atomically applies a gift card to a checkout: locks the gift card row, validates PIN/expiry, debits the admin reserve wallet, holds the same amount in the buyer escrow, decrements the card balance, and logs a gift_card_transactions row in one Postgres transaction. Prevents double-spending and ensures the escrow hold and reserve debit are always paired.';

REVOKE ALL ON FUNCTION redeem_gift_card_atomic(TEXT, TEXT, UUID, UUID, NUMERIC, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION redeem_gift_card_atomic(TEXT, TEXT, UUID, UUID, NUMERIC, UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION redeem_gift_card_atomic(TEXT, TEXT, UUID, UUID, NUMERIC, UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION redeem_gift_card_atomic(TEXT, TEXT, UUID, UUID, NUMERIC, UUID, TEXT, TEXT) TO service_role;
ALTER FUNCTION redeem_gift_card_atomic(TEXT, TEXT, UUID, UUID, NUMERIC, UUID, TEXT, TEXT) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
--   select has_function_privilege('service_role', 'redeem_gift_card_atomic(text,text,uuid,uuid,numeric,uuid,text,text)', 'EXECUTE') as service_role_can_call,
--          has_function_privilege('authenticated', 'redeem_gift_card_atomic(text,text,uuid,uuid,numeric,uuid,text,text)', 'EXECUTE') as authenticated_can_call;
--
-- Expected: service_role_can_call = true, authenticated_can_call = false.
--
-- Next step: replace the multi-call sequence in
-- GiftCardsService.applyToCheckout() with a single call to this RPC.
-- =====================================================
