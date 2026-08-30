-- =====================================================
-- Migration: 195
-- Add send_live_stream_gift_atomic(): a single RPC that atomically debits
-- the viewer, credits the stream vendor, and records the gift.
--
-- Background (the bug this fixes):
--   LiveSalesService.sendGift() currently does: fee_deduction from sender,
--   reward_credit to vendor, then (if vendor credit fails) admin_adjust refund
--   back to the sender, and only then inserts the live_stream_gifts row. This
--   is a multi-call saga: if the gift insert fails after the money has moved,
--   the gift is paid for but not recorded.
--
-- What this migration does:
--   send_live_stream_gift_atomic() performs the viewer debit, the vendor
--   credit, and the live_stream_gifts insert in one Postgres transaction.
--   A failure anywhere rolls the whole gift back. No manual rollback is needed.
--
--   This is additive-only: it only creates one new function.
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION send_live_stream_gift_atomic(
  p_stream_id UUID,
  p_sender_id UUID,
  p_vendor_id UUID,
  p_gift_type_id UUID,
  p_quantity INTEGER,
  p_unit_value NUMERIC,
  p_total_amount NUMERIC,
  p_message TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_stream_title TEXT;
  v_total_amount DECIMAL(18,6);
  v_debit_result RECORD;
  v_credit_result RECORD;
  v_gift_record RECORD;
  v_gift_name TEXT;
BEGIN
  -- 1. Validate inputs.
  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 10 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Gift quantity must be between 1 and 10',
      'error_code', 'INVALID_QUANTITY'
    );
  END IF;

  IF p_total_amount IS NULL OR p_total_amount <= 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Total amount must be positive',
      'error_code', 'INVALID_AMOUNT'
    );
  END IF;

  v_total_amount := ROUND(p_total_amount::NUMERIC, 6);

  -- 2. Verify stream is live and get title for description.
  SELECT title
  INTO v_stream_title
  FROM live_streams
  WHERE id = p_stream_id
    AND status = 'live';

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Live stream not found or not active',
      'error_code', 'STREAM_NOT_LIVE'
    );
  END IF;

  -- 3. Get gift name for description.
  SELECT name
  INTO v_gift_name
  FROM gift_types
  WHERE id = p_gift_type_id;

  IF NOT FOUND THEN
    SELECT name
    INTO v_gift_name
    FROM virtual_gifts
    WHERE id = p_gift_type_id;
  END IF;

  IF v_gift_name IS NULL THEN
    v_gift_name := 'gift';
  END IF;

  -- 4. Debit sender.
  SELECT * INTO v_debit_result
  FROM process_wallet_transaction(
    p_sender_id,
    'fee_deduction',
    -v_total_amount,
    format('Gift: %sx %s to stream "%s"', p_quantity, v_gift_name, v_stream_title),
    p_stream_id::TEXT,
    'live_stream_gift'
  );

  IF NOT v_debit_result.success THEN
    RAISE EXCEPTION 'Failed to debit sender for live gift: %', v_debit_result.error_message;
  END IF;

  -- 5. Credit vendor.
  SELECT * INTO v_credit_result
  FROM process_wallet_transaction(
    p_vendor_id,
    'reward_credit',
    v_total_amount,
    format('Gift received: %sx %s from viewer', p_quantity, v_gift_name),
    p_stream_id::TEXT,
    'live_stream_gift'
  );

  IF NOT v_credit_result.success THEN
    RAISE EXCEPTION 'Failed to credit vendor for live gift: %', v_credit_result.error_message;
  END IF;

  -- 6. Record the gift.
  INSERT INTO live_stream_gifts (
    stream_id,
    sender_id,
    gift_type_id,
    quantity,
    unit_value,
    total_amount,
    message,
    created_at,
    updated_at
  )
  VALUES (
    p_stream_id,
    p_sender_id,
    p_gift_type_id,
    p_quantity,
    v_total_amount / p_quantity,
    v_total_amount,
    p_message,
    NOW(),
    NOW()
  )
  RETURNING *
  INTO v_gift_record;

  RETURN jsonb_build_object(
    'success', true,
    'gift', to_jsonb(v_gift_record),
    'debit_transaction_id', v_debit_result.transaction_id,
    'credit_transaction_id', v_credit_result.transaction_id
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error in send_live_stream_gift_atomic: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during live stream gift send',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION send_live_stream_gift_atomic IS
'Atomically sends a live stream gift: debits the viewer, credits the vendor, and inserts the live_stream_gifts record in a single Postgres transaction.';

REVOKE ALL ON FUNCTION send_live_stream_gift_atomic(UUID, UUID, UUID, UUID, INTEGER, NUMERIC, NUMERIC, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION send_live_stream_gift_atomic(UUID, UUID, UUID, UUID, INTEGER, NUMERIC, NUMERIC, TEXT) FROM anon;
REVOKE ALL ON FUNCTION send_live_stream_gift_atomic(UUID, UUID, UUID, UUID, INTEGER, NUMERIC, NUMERIC, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION send_live_stream_gift_atomic(UUID, UUID, UUID, UUID, INTEGER, NUMERIC, NUMERIC, TEXT) TO service_role;
ALTER FUNCTION send_live_stream_gift_atomic(UUID, UUID, UUID, UUID, INTEGER, NUMERIC, NUMERIC, TEXT) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'send_live_stream_gift_atomic(uuid,uuid,uuid,uuid,integer,numeric,numeric,text)', 'EXECUTE') as gift_ok,
--        has_function_privilege('authenticated', 'send_live_stream_gift_atomic(uuid,uuid,uuid,uuid,integer,numeric,numeric,text)', 'EXECUTE') as gift_auth_ok;
--
-- Expected: gift_ok = true, gift_auth_ok = false.
--
-- Next step: replace the multi-call sequence in
-- LiveSalesService.sendGift() with a single call to this RPC.
-- =====================================================
