-- =====================================================
-- Migration: 191
-- Add revert_gift_card_redemption_atomic(): a single RPC that atomically
-- reverses a gift card redemption by releasing the buyer's escrow hold,
-- restoring the marketing reserve, updating the gift card balance/status,
-- and logging an admin_adjust transaction.
--
-- Background (the bug this fixes):
--   GiftCardsService.revertGiftCardApplication() and refundGiftCard() each
--   do two wallet calls and then update gift_cards + gift_card_transactions.
--   If the wallet calls succeed but the balance/status/log update fails, the
--   money has moved but the card is not restored, allowing a retry to
--   double-credit the reserve or buyer.
--
-- What this migration does:
--   revert_gift_card_redemption_atomic() locks the redeem transaction and
--   the gift card row, validates the reversal amount, performs the
--   GIFT_CARD_ESCROW_HOLD and GIFT_CARD_PURCHASE wallet calls, updates the
--   gift card balance/status, and inserts the admin_adjust audit row in the
--   same Postgres transaction. A failure anywhere rolls everything back.
--
--   This is additive-only: it only creates one new function.
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION revert_gift_card_redemption_atomic(
  p_transaction_id UUID,
  p_amount NUMERIC,
  p_reason TEXT,
  p_admin_gift_user_id UUID,
  p_order_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_transaction RECORD;
  v_gift_card RECORD;
  v_user_id UUID;
  v_revert_amount DECIMAL(18,6);
  v_new_balance DECIMAL(18,6);
  v_new_status VARCHAR(50);
  v_escrow_result RECORD;
  v_reserve_result RECORD;
  v_metadata JSONB;
  v_description TEXT;
BEGIN
  -- 1. Validate amount.
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Reversal amount must be positive',
      'error_code', 'INVALID_AMOUNT'
    );
  END IF;

  v_revert_amount := ROUND(p_amount::NUMERIC, 6);

  -- 2. Lock and fetch the redeem transaction and the gift card.
  SELECT *
  INTO v_transaction
  FROM gift_card_transactions
  WHERE id = p_transaction_id
    AND transaction_type = 'redeem'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Redeem transaction not found',
      'error_code', 'TRANSACTION_NOT_FOUND'
    );
  END IF;

  SELECT *
  INTO v_gift_card
  FROM gift_cards
  WHERE id = v_transaction.gift_card_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Gift card not found',
      'error_code', 'GIFT_CARD_NOT_FOUND'
    );
  END IF;

  v_user_id := COALESCE(v_transaction.user_id, v_gift_card.recipient_user_id);

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'No user associated with this gift card transaction',
      'error_code', 'NO_USER'
    );
  END IF;

  -- 3. Release the buyer's escrow hold (GIFT_CARD_ESCROW_HOLD negative).
  v_description := format('Reversal: gift card application reverted (%s)', p_reason);
  SELECT * INTO v_escrow_result
  FROM process_wallet_transaction(
    v_user_id,
    'GIFT_CARD_ESCROW_HOLD',
    -v_revert_amount,
    v_description,
    p_transaction_id::TEXT,
    'gift_card_redeem_revert'
  );

  IF NOT v_escrow_result.success THEN
    RAISE EXCEPTION 'Failed to reverse gift card escrow hold for transaction %: %', p_transaction_id, v_escrow_result.error_message;
  END IF;

  -- 4. Restore the marketing/reserve wallet.
  v_description := format('Reversal: gift card application reverted (%s)', p_reason);
  SELECT * INTO v_reserve_result
  FROM process_wallet_transaction(
    p_admin_gift_user_id,
    'GIFT_CARD_PURCHASE',
    v_revert_amount,
    v_description,
    p_transaction_id::TEXT,
    'gift_card_redeem_revert'
  );

  IF NOT v_reserve_result.success THEN
    RAISE EXCEPTION 'Failed to restore marketing wallet reserve for transaction %: %', p_transaction_id, v_reserve_result.error_message;
  END IF;

  -- 5. Update the gift card balance and status.
  v_new_balance := COALESCE(v_gift_card.current_balance, 0) + v_revert_amount;
  v_new_status := CASE
    WHEN v_gift_card.status = 'redeemed' THEN 'claimed'
    ELSE v_gift_card.status
  END;

  UPDATE gift_cards
  SET
    current_balance = v_new_balance,
    status = v_new_status,
    updated_at = NOW()
  WHERE id = v_gift_card.id;

  -- 6. Log the admin_adjust transaction.
  v_metadata := jsonb_build_object(
    'reason', p_reason,
    'reverted_transaction_id', p_transaction_id
  );

  IF p_order_id IS NOT NULL THEN
    v_metadata := v_metadata || jsonb_build_object('order_id', p_order_id);
  END IF;

  INSERT INTO gift_card_transactions (
    gift_card_id,
    transaction_type,
    amount,
    balance_after,
    user_id,
    metadata,
    created_at,
    updated_at
  )
  VALUES (
    v_gift_card.id,
    'admin_adjust',
    v_revert_amount,
    v_new_balance,
    v_user_id,
    v_metadata,
    NOW(),
    NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', p_transaction_id,
    'gift_card_id', v_gift_card.id,
    'revert_amount', v_revert_amount,
    'new_balance', v_new_balance,
    'status', v_new_status,
    'user_id', v_user_id
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error in revert_gift_card_redemption_atomic: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during gift card reversal',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION revert_gift_card_redemption_atomic IS
'Atomically reverses a gift card redemption: releases the buyer escrow hold, restores the marketing reserve, updates the gift card balance and status, and logs an admin_adjust row in a single Postgres transaction.';

REVOKE ALL ON FUNCTION revert_gift_card_redemption_atomic(UUID, NUMERIC, TEXT, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION revert_gift_card_redemption_atomic(UUID, NUMERIC, TEXT, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION revert_gift_card_redemption_atomic(UUID, NUMERIC, TEXT, UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION revert_gift_card_redemption_atomic(UUID, NUMERIC, TEXT, UUID, UUID) TO service_role;
ALTER FUNCTION revert_gift_card_redemption_atomic(UUID, NUMERIC, TEXT, UUID, UUID) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'revert_gift_card_redemption_atomic(uuid,numeric,text,uuid,uuid)', 'EXECUTE') as revert_ok,
--        has_function_privilege('authenticated', 'revert_gift_card_redemption_atomic(uuid,numeric,text,uuid,uuid)', 'EXECUTE') as revert_auth_ok;
--
-- Expected: revert_ok = true, revert_auth_ok = false.
--
-- Next step: replace the multi-call sequences in
-- GiftCardsService.revertGiftCardApplication() and refundGiftCard() with
-- a single call to this RPC.
-- =====================================================
