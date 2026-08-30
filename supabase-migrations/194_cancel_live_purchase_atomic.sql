-- =====================================================
-- Migration: 194
-- Add cancel_live_purchase_atomic(): a single RPC that atomically refunds
-- a live-sale purchase from escrow back to the buyer and cancels the order.
--
-- Background (the bug this fixes):
--   LiveSalesService.rollbackPurchaseTransaction() currently refunds the
--   buyer and only then updates the orders.status to 'cancelled'. It does
--   NOT update the escrows row, so the escrow can stay 'held' even after the
--   money has been refunded. If the order update fails, the same order can
--   also be refunded again.
--
-- What this migration does:
--   cancel_live_purchase_atomic() locks the order and its escrow row,
--   validates the buyer and the held escrow, performs the ESCROW_REFUND,
--   updates escrows.status to 'refunded', and sets orders.status to
--   'cancelled' with the provided metadata, all in one Postgres transaction.
--   A failure anywhere rolls everything back.
--
--   This is additive-only: it only creates one new function.
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION cancel_live_purchase_atomic(
  p_order_id UUID,
  p_user_id UUID,
  p_amount NUMERIC,
  p_reason TEXT,
  p_metadata JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order RECORD;
  v_escrow RECORD;
  v_refund_amount DECIMAL(18,6);
  v_refund_result RECORD;
BEGIN
  -- 1. Validate amount.
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Refund amount must be positive',
      'error_code', 'INVALID_AMOUNT'
    );
  END IF;

  v_refund_amount := ROUND(p_amount::NUMERIC, 6);

  -- 2. Lock and fetch order + escrow.
  SELECT *
  INTO v_order
  FROM orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Order not found',
      'error_code', 'ORDER_NOT_FOUND'
    );
  END IF;

  IF v_order.buyer_id != p_user_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Only the buyer can cancel this order',
      'error_code', 'UNAUTHORIZED'
    );
  END IF;

  SELECT *
  INTO v_escrow
  FROM escrows
  WHERE order_id = p_order_id
    AND status = 'held'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Escrow not found or already released',
      'error_code', 'ESCROW_NOT_FOUND'
    );
  END IF;

  -- 3. Refund buyer from escrow.
  SELECT * INTO v_refund_result
  FROM process_wallet_transaction(
    p_user_id,
    'escrow_refund',
    v_refund_amount,
    format('Rollback: %s', p_reason),
    p_order_id::TEXT,
    'order'
  );

  IF NOT v_refund_result.success THEN
    RAISE EXCEPTION 'Failed to refund buyer for order %: %', p_order_id, v_refund_result.error_message;
  END IF;

  -- 4. Update escrow and order status in the same transaction.
  UPDATE escrows
  SET
    status = 'refunded',
    refund_reason = p_reason,
    updated_at = NOW()
  WHERE id = v_escrow.id
    AND status = 'held';

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Escrow status changed during processing',
      'error_code', 'STATUS_CHANGED'
    );
  END IF;

  UPDATE orders
  SET
    status = 'cancelled',
    metadata = COALESCE(p_metadata, metadata),
    updated_at = NOW()
  WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success', true,
    'order', jsonb_build_object(
      'id', v_order.id,
      'order_number', v_order.order_number,
      'buyer_id', v_order.buyer_id,
      'status', 'cancelled'
    ),
    'escrow', jsonb_build_object(
      'id', v_escrow.id,
      'status', 'refunded',
      'refund_amount', v_refund_amount
    )
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error in cancel_live_purchase_atomic: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during live purchase cancellation',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION cancel_live_purchase_atomic IS
'Atomically cancels a live purchase: refunds the buyer from escrow, marks the escrow as refunded, and cancels the order in a single Postgres transaction.';

REVOKE ALL ON FUNCTION cancel_live_purchase_atomic(UUID, UUID, NUMERIC, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION cancel_live_purchase_atomic(UUID, UUID, NUMERIC, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION cancel_live_purchase_atomic(UUID, UUID, NUMERIC, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION cancel_live_purchase_atomic(UUID, UUID, NUMERIC, TEXT, JSONB) TO service_role;
ALTER FUNCTION cancel_live_purchase_atomic(UUID, UUID, NUMERIC, TEXT, JSONB) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'cancel_live_purchase_atomic(uuid,uuid,numeric,text,jsonb)', 'EXECUTE') as cancel_ok,
--        has_function_privilege('authenticated', 'cancel_live_purchase_atomic(uuid,uuid,numeric,text,jsonb)', 'EXECUTE') as cancel_auth_ok;
--
-- Expected: cancel_ok = true, cancel_auth_ok = false.
--
-- Next step: replace the multi-call sequence in
-- LiveSalesService.rollbackPurchaseTransaction() with a single call to this RPC.
-- =====================================================
