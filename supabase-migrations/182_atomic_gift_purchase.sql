-- =====================================================
-- Migration: 182
-- Add purchase_gifts_atomic(): a single RPC that atomically
-- completes the entire gift-purchase flow.
--
-- Background (the bug this fixes):
--   gift.service.ts purchaseGifts() currently does the following
--   as separate Supabase network calls:
--     1. processWalletTransaction('gift_purchase', -totalCost) - debit user
--     2. processWalletTransaction('platform_commission', +totalCost) - credit admin gift wallet
--     3. Update/insert user_gifts for each purchased gift
--     4. Insert gift_transactions for each purchased gift
--   Steps 2-4 happen *after* the user's wallet has already been
--   debited. If any of them fails, the user has been charged but
--   no gifts are credited, no admin wallet is credited, and no
--   transaction record exists. The existing code even has a
--   "CRITICAL" log for this exact case and continues regardless.
--   This is a classic multi-step saga that is not ACID.
--
-- What this migration does:
--   Adds purchase_gifts_atomic(), which in one Postgres transaction:
--     1. Calls process_wallet_transaction('gift_purchase', -totalCost)
--       for the buyer.
--     2. Treats an idempotent debit as "already processed" and
--       returns immediately - this is the safety guard against
--       retries or duplicate requests.
--     3. Calls process_wallet_transaction('platform_commission',
--       +totalCost) for the admin/platform gift wallet.
--     4. Upserts user_gifts for every item.
--     5. Inserts gift_transactions for every item.
--   If any step fails, the entire transaction rolls back, so the
--   buyer is never charged without receiving the goods and the
--   platform wallet is never out of sync.
--
--   This is additive only and does not modify the existing
--   process_wallet_transaction, virtual_gifts, user_gifts, or
--   gift_transactions tables.
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION purchase_gifts_atomic(
  p_user_id UUID,
  p_admin_user_id UUID,
  p_total_cost NUMERIC,
  p_purchases JSONB,
  p_reference_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_debit_result RECORD;
  v_credit_result RECORD;
  v_purchase JSONB;
  v_gift_id UUID;
  v_quantity INTEGER;
  v_credit_amount INTEGER;
  v_sum NUMERIC;
  v_user_gift_result RECORD;
BEGIN
  -- 1. Validate inputs.
  IF p_purchases IS NULL OR jsonb_array_length(p_purchases) = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'No gifts provided for purchase',
      'error_code', 'NO_PURCHASES'
    );
  END IF;

  IF p_total_cost IS NULL OR p_total_cost <= 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Total cost must be positive',
      'error_code', 'INVALID_TOTAL'
    );
  END IF;

  -- Ensure the provided total matches the sum of line-item credit amounts.
  SELECT COALESCE(SUM((elem->>'credit_amount')::NUMERIC), 0)
  INTO v_sum
  FROM jsonb_array_elements(p_purchases) AS elem;

  IF v_sum <> p_total_cost THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Total cost %s does not match sum of line items %s', p_total_cost, v_sum),
      'error_code', 'TOTAL_MISMATCH'
    );
  END IF;

  -- 2. Debit the buyer. process_wallet_transaction handles its own
  --    wallet row lock and idempotency on (user_id, transaction_type,
  --    reference_type, reference_id).
  SELECT * INTO v_debit_result
  FROM process_wallet_transaction(
    p_user_id,
    'gift_purchase',
    -p_total_cost,
    format('Purchase of %s gift type(s)', jsonb_array_length(p_purchases)),
    p_reference_id,
    'gift_purchase'
  );

  IF NOT v_debit_result.success THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', v_debit_result.error_message,
      'error_code', 'DEBIT_FAILED'
    );
  END IF;

  -- If the buyer's ledger row already exists for this reference, the
  -- whole purchase was already committed. Do not re-add gifts or
  -- transactions - this is the idempotent "already processed" guard.
  IF v_debit_result.idempotent THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'transaction_id', v_debit_result.transaction_id
    );
  END IF;

  -- 3. Credit the admin/platform gift wallet. This is part of the
  --    same transaction, so a failure here rolls back the buyer's
  --    debit as well.
  SELECT * INTO v_credit_result
  FROM process_wallet_transaction(
    p_admin_user_id,
    'platform_commission',
    p_total_cost,
    format('Gift purchase from user %s', p_user_id),
    p_reference_id,
    'gift_purchase'
  );

  IF NOT v_credit_result.success THEN
    RAISE EXCEPTION 'Admin gift wallet credit failed for reference %: %', p_reference_id, v_credit_result.error_message;
  END IF;

  -- 4. Upsert user_gifts and insert gift_transactions for every item.
  FOR v_purchase IN SELECT * FROM jsonb_array_elements(p_purchases)
  LOOP
    v_gift_id := (v_purchase->>'gift_id')::UUID;
    v_quantity := (v_purchase->>'quantity')::INTEGER;
    v_credit_amount := (v_purchase->>'credit_amount')::INTEGER;

    IF v_gift_id IS NULL OR v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Invalid purchase item: gift_id=% quantity=%', v_gift_id, v_quantity;
    END IF;

    INSERT INTO user_gifts (
      user_id,
      gift_id,
      quantity,
      source,
      received_from,
      session_id
    )
    VALUES (
      p_user_id,
      v_gift_id,
      v_quantity,
      'purchased',
      NULL,
      NULL
    )
    ON CONFLICT (user_id, gift_id, source, received_from, session_id)
    DO UPDATE SET
      quantity = user_gifts.quantity + EXCLUDED.quantity,
      updated_at = NOW();

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
      'purchase',
      v_credit_amount,
      NULL,
      NULL,
      NULL
    );
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'transaction_id', v_debit_result.transaction_id,
    'total_cost', p_total_cost
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error in purchase_gifts_atomic: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during gift purchase',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION purchase_gifts_atomic IS
'Atomically purchases virtual gifts: debits the buyer, credits the admin gift wallet, upserts user_gifts, and inserts gift_transaction records in one Postgres transaction. Uses process_wallet_transaction for wallet movements and the buyer ledger row as the idempotency marker. Returns already_processed=true if the buyer debit already exists for the given reference.';

REVOKE ALL ON FUNCTION purchase_gifts_atomic(UUID, UUID, NUMERIC, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION purchase_gifts_atomic(UUID, UUID, NUMERIC, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION purchase_gifts_atomic(UUID, UUID, NUMERIC, JSONB, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION purchase_gifts_atomic(UUID, UUID, NUMERIC, JSONB, TEXT) TO service_role;
ALTER FUNCTION purchase_gifts_atomic(UUID, UUID, NUMERIC, JSONB, TEXT) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
--   select has_function_privilege('service_role', 'purchase_gifts_atomic(uuid,uuid,numeric,jsonb,text)', 'EXECUTE') as service_role_can_call,
--          has_function_privilege('authenticated', 'purchase_gifts_atomic(uuid,uuid,numeric,jsonb,text)', 'EXECUTE') as authenticated_can_call;
--
-- Expected: service_role_can_call = true, authenticated_can_call = false.
--
-- Next step: replace the multi-call sequence in
-- GiftService.purchaseGifts() with a single call to this RPC.
-- =====================================================
