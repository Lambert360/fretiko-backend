-- =====================================================
-- Migration: 183
-- Add convert_gifts_atomic(): a single RPC that atomically
-- converts a user's virtual gifts back to wallet credits.
--
-- Background (the bug this fixes):
--   gift.service.ts convertGiftsToCredits() currently does the
--   following as separate Supabase network calls:
--     1. processWalletTransaction('gift_conversion', -totalValue)
--        on the admin gift wallet
--     2. processWalletTransaction('gift_conversion', +userCredit)
--        on the user's wallet
--     3. processWalletTransaction('platform_commission', +platformFee)
--        on the platform user wallet
--     4. Delete or decrement user_gifts rows
--     5. Insert gift_transactions rows for 'convert'
--   The current code even has a manual "rollback" call if the
--   user credit fails (step 2), but that rollback is itself a
--   separate network call and can also fail, leaving the admin
--   wallet debited while the user was never credited. If steps
--   4-5 fail after step 2, the user is credited but the gifts are
--   never removed, so the same gifts could be converted again.
--   This is a multi-step saga that is not ACID.
--
-- What this migration does:
--   Adds convert_gifts_atomic(), which in one Postgres transaction:
--     1. Debits the admin gift wallet for the full gift value.
--     2. Credits the user for the 80% (or other) share.
--     3. Credits the platform wallet for the 20% fee.
--     4. Decrements or deletes the relevant user_gifts rows
--       (using FOR UPDATE locks ordered by ID to avoid deadlocks).
--     5. Inserts 'convert' records into gift_transactions.
--   If any step fails, the entire transaction rolls back. The
--   admin wallet is never left debited with no user credit, and
--   the user is never credited without the gifts being consumed.
--
--   This is additive only and does not modify existing tables or
--   process_wallet_transaction.
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION convert_gifts_atomic(
  p_user_id UUID,
  p_admin_gift_user_id UUID,
  p_platform_user_id UUID,
  p_total_value NUMERIC,
  p_user_credit NUMERIC,
  p_platform_fee NUMERIC,
  p_conversions JSONB,
  p_reference_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_admin_debit_result RECORD;
  v_user_credit_result RECORD;
  v_platform_credit_result RECORD;
  v_conversion JSONB;
  v_user_gift_id UUID;
  v_gift_id UUID;
  v_quantity INTEGER;
  v_credit_amount INTEGER;
  v_user_gift RECORD;
  v_sum NUMERIC;
BEGIN
  -- 1. Validate inputs.
  IF p_conversions IS NULL OR jsonb_array_length(p_conversions) = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'No gifts provided for conversion',
      'error_code', 'NO_CONVERSIONS'
    );
  END IF;

  IF p_total_value IS NULL OR p_total_value <= 0
     OR p_user_credit IS NULL OR p_user_credit < 0
     OR p_platform_fee IS NULL OR p_platform_fee < 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Invalid conversion amounts',
      'error_code', 'INVALID_AMOUNTS'
    );
  END IF;

  IF p_user_credit + p_platform_fee <> p_total_value THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('User credit %s + platform fee %s must equal total value %s', p_user_credit, p_platform_fee, p_total_value),
      'error_code', 'AMOUNT_MISMATCH'
    );
  END IF;

  SELECT COALESCE(SUM((elem->>'credit_amount')::NUMERIC), 0)
  INTO v_sum
  FROM jsonb_array_elements(p_conversions) AS elem;

  IF v_sum <> p_total_value THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Total value %s does not match sum of line items %s', p_total_value, v_sum),
      'error_code', 'LINE_ITEM_MISMATCH'
    );
  END IF;

  -- 2. Debit admin gift wallet for the full value. process_wallet_transaction
  --    locks the admin wallet row and is idempotent for this reference.
  SELECT * INTO v_admin_debit_result
  FROM process_wallet_transaction(
    p_admin_gift_user_id,
    'gift_conversion',
    -p_total_value,
    format('Gift conversion: %s gift type(s) from user %s', jsonb_array_length(p_conversions), p_user_id),
    p_reference_id,
    'gift_conversion'
  );

  IF NOT v_admin_debit_result.success THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', v_admin_debit_result.error_message,
      'error_code', 'ADMIN_DEBIT_FAILED'
    );
  END IF;

  -- If the admin ledger row already exists for this reference, the
  -- whole conversion was already committed. Skip side effects.
  IF v_admin_debit_result.idempotent THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'transaction_id', v_admin_debit_result.transaction_id
    );
  END IF;

  -- 3. Credit the user wallet. Same transaction, so a failure rolls
  --    back the admin debit too.
  SELECT * INTO v_user_credit_result
  FROM process_wallet_transaction(
    p_user_id,
    'gift_conversion',
    p_user_credit,
    format('Gift conversion: %s gift type(s) credited to wallet', jsonb_array_length(p_conversions)),
    p_reference_id,
    'gift_conversion'
  );

  IF NOT v_user_credit_result.success THEN
    RAISE EXCEPTION 'User wallet credit failed for reference %: %', p_reference_id, v_user_credit_result.error_message;
  END IF;

  -- 4. Credit the platform wallet with the fee.
  SELECT * INTO v_platform_credit_result
  FROM process_wallet_transaction(
    p_platform_user_id,
    'platform_commission',
    p_platform_fee,
    format('Gift conversion fee (20%%) from user %s - %s gift(s) converted', p_user_id, jsonb_array_length(p_conversions)),
    p_reference_id,
    'gift_conversion'
  );

  IF NOT v_platform_credit_result.success THEN
    RAISE EXCEPTION 'Platform wallet credit failed for reference %: %', p_reference_id, v_platform_credit_result.error_message;
  END IF;

  -- 5. Consume user_gifts and insert gift_transactions.
  --    Lock rows in deterministic order to avoid deadlocks.
  FOR v_conversion IN
    SELECT elem.*
    FROM jsonb_array_elements(p_conversions) AS elem
    ORDER BY elem->>'user_gift_id'
  LOOP
    v_user_gift_id := (v_conversion->>'user_gift_id')::UUID;
    v_gift_id := (v_conversion->>'gift_id')::UUID;
    v_quantity := (v_conversion->>'quantity')::INTEGER;
    v_credit_amount := (v_conversion->>'credit_amount')::INTEGER;

    IF v_user_gift_id IS NULL OR v_gift_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid conversion item: user_gift_id=% gift_id=% quantity=%', v_user_gift_id, v_gift_id, v_quantity;
    END IF;

    SELECT * INTO v_user_gift
    FROM user_gifts
    WHERE id = v_user_gift_id
      AND user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'User gift % not found for user %', v_user_gift_id, p_user_id;
    END IF;

    IF v_user_gift.quantity < v_quantity THEN
      RAISE EXCEPTION 'Insufficient quantity for user_gift %: has %, requested %', v_user_gift_id, v_user_gift.quantity, v_quantity;
    END IF;

    IF v_user_gift.quantity = v_quantity THEN
      DELETE FROM user_gifts WHERE id = v_user_gift_id;
    ELSE
      UPDATE user_gifts
      SET quantity = quantity - v_quantity,
          updated_at = NOW()
      WHERE id = v_user_gift_id;
    END IF;

    INSERT INTO gift_transactions (
      user_id,
      gift_id,
      quantity,
      transaction_type,
      credit_amount,
      recipient_id,
      session_type,
      session_id
    )
    VALUES (
      p_user_id,
      v_gift_id,
      v_quantity,
      'convert',
      v_credit_amount,
      NULL,
      NULL,
      NULL
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'transaction_id', v_user_credit_result.transaction_id,
    'user_credit', p_user_credit,
    'platform_fee', p_platform_fee,
    'total_value', p_total_value
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error in convert_gifts_atomic: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during gift conversion',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION convert_gifts_atomic IS
'Atomically converts virtual gifts to wallet credits: debits admin gift wallet, credits user and platform wallets, consumes user_gifts, and inserts gift_transactions in one Postgres transaction. Uses process_wallet_transaction for wallet movements and the admin gift_conversion ledger row as the idempotency marker. Locks user_gift rows in deterministic order to avoid deadlocks.';

REVOKE ALL ON FUNCTION convert_gifts_atomic(UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION convert_gifts_atomic(UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION convert_gifts_atomic(UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION convert_gifts_atomic(UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, TEXT) TO service_role;
ALTER FUNCTION convert_gifts_atomic(UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, TEXT) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
--   select has_function_privilege('service_role', 'convert_gifts_atomic(uuid,uuid,uuid,numeric,numeric,numeric,jsonb,text)', 'EXECUTE') as service_role_can_call,
--          has_function_privilege('authenticated', 'convert_gifts_atomic(uuid,uuid,uuid,numeric,numeric,numeric,jsonb,text)', 'EXECUTE') as authenticated_can_call;
--
-- Expected: service_role_can_call = true, authenticated_can_call = false.
--
-- Next step: replace the multi-call sequence in
-- GiftService.convertGiftsToCredits() with a single call to this RPC.
-- =====================================================
