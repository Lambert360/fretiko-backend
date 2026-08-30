-- =====================================================
-- Migration: 196
-- Add complete_purchase_hold_atomic(): a single RPC that atomically holds
-- the buyer's wallet funds in escrow and updates the orders row.
--
-- Background (the bug this fixes):
--   Multiple checkout, live-sale, and wishlist purchase flows currently do a
--   PURCHASE_HOLD wallet call and then separately update orders with pins,
--   status, and metadata. If the wallet call succeeds but the orders update
--   fails, the money is held but the order is not properly marked, leading to
--   inconsistent state and making retries risky.
--
-- What this migration does:
--   complete_purchase_hold_atomic() locks the orders row, validates the
--   buyer, performs the PURCHASE_HOLD wallet transaction, and updates only the
--   orders fields provided (status, pickup_pin, delivery_pin, metadata) in the
--   same Postgres transaction. A failure anywhere rolls everything back.
--
--   This is additive-only: it only creates one new function.
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION complete_purchase_hold_atomic(
  p_order_id UUID,
  p_buyer_id UUID,
  p_amount NUMERIC,
  p_description TEXT,
  p_status VARCHAR(50) DEFAULT NULL,
  p_pickup_pin VARCHAR(20) DEFAULT NULL,
  p_delivery_pin VARCHAR(20) DEFAULT NULL,
  p_metadata JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order RECORD;
  v_hold_amount DECIMAL(18,6);
  v_hold_result RECORD;
  v_update_fields TEXT[];
  v_sql TEXT;
BEGIN
  -- 1. Validate amount.
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Hold amount must be positive',
      'error_code', 'INVALID_AMOUNT'
    );
  END IF;

  v_hold_amount := ROUND(p_amount::NUMERIC, 6);

  -- 2. Lock and fetch the order.
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

  IF v_order.buyer_id != p_buyer_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Only the buyer can place a hold on this order',
      'error_code', 'UNAUTHORIZED'
    );
  END IF;

  -- 3. Hold funds in buyer's escrow.
  SELECT * INTO v_hold_result
  FROM process_wallet_transaction(
    p_buyer_id,
    'PURCHASE_HOLD',
    v_hold_amount,
    p_description,
    p_order_id::TEXT,
    'order'
  );

  IF NOT v_hold_result.success THEN
    RAISE EXCEPTION 'Failed to hold funds for order %: %', p_order_id, v_hold_result.error_message;
  END IF;

  -- 4. Update only the provided fields in orders.
  v_update_fields := ARRAY['updated_at = NOW()'];

  IF p_status IS NOT NULL THEN
    v_update_fields := array_append(v_update_fields, format('status = %L', p_status));
  END IF;

  IF p_pickup_pin IS NOT NULL THEN
    v_update_fields := array_append(v_update_fields, format('pickup_pin = %L', p_pickup_pin));
  END IF;

  IF p_delivery_pin IS NOT NULL THEN
    v_update_fields := array_append(v_update_fields, format('delivery_pin = %L', p_delivery_pin));
  END IF;

  IF p_metadata IS NOT NULL THEN
    v_update_fields := array_append(v_update_fields, format('metadata = COALESCE(metadata, %L::jsonb) || %L::jsonb', '{}', p_metadata));
  END IF;

  v_sql := format(
    'UPDATE orders SET %s WHERE id = %L',
    array_to_string(v_update_fields, ', '),
    p_order_id
  );

  EXECUTE v_sql;

  RETURN jsonb_build_object(
    'success', true,
    'order', jsonb_build_object(
      'id', v_order.id,
      'order_number', v_order.order_number,
      'buyer_id', v_order.buyer_id,
      'status', COALESCE(p_status, v_order.status)
    ),
    'hold_transaction_id', v_hold_result.transaction_id
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error in complete_purchase_hold_atomic: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during purchase hold',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION complete_purchase_hold_atomic IS
'Atomically holds the buyer wallet funds in escrow and updates the order row (status, pins, metadata) in a single Postgres transaction.';

REVOKE ALL ON FUNCTION complete_purchase_hold_atomic(UUID, UUID, NUMERIC, TEXT, VARCHAR, VARCHAR, VARCHAR, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_purchase_hold_atomic(UUID, UUID, NUMERIC, TEXT, VARCHAR, VARCHAR, VARCHAR, JSONB) FROM anon;
REVOKE ALL ON FUNCTION complete_purchase_hold_atomic(UUID, UUID, NUMERIC, TEXT, VARCHAR, VARCHAR, VARCHAR, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION complete_purchase_hold_atomic(UUID, UUID, NUMERIC, TEXT, VARCHAR, VARCHAR, VARCHAR, JSONB) TO service_role;
ALTER FUNCTION complete_purchase_hold_atomic(UUID, UUID, NUMERIC, TEXT, VARCHAR, VARCHAR, VARCHAR, JSONB) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'complete_purchase_hold_atomic(uuid,uuid,numeric,text,varchar,varchar,varchar,jsonb)', 'EXECUTE') as hold_ok,
--        has_function_privilege('authenticated', 'complete_purchase_hold_atomic(uuid,uuid,numeric,text,varchar,varchar,varchar,jsonb)', 'EXECUTE') as hold_auth_ok;
--
-- Expected: hold_ok = true, hold_auth_ok = false.
--
-- Next step: replace the PURCHASE_HOLD + orders.update sequences in
-- checkout, live-sales, and wishlist services with a single call to this RPC.
-- =====================================================
