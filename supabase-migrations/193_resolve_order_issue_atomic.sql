-- =====================================================
-- Migration: 193
-- Add resolve_order_issue_atomic(): a single RPC that atomically moves an
-- order into dispute/cancelled, refunds the buyer (total - delivery fee),
-- and pays the rider/partner their delivery fee.
--
-- Background (the bug this fixes):
--   OrdersService.reportIssue() currently updates escrows.status = 'dispute'
--   and orders.status = 'cancelled' BEFORE the wallet calls. If the refund
--   or rider payment fails, the order is already cancelled but the money has
--   not moved, leaving the buyer/rider unpaid and making retries risky.
--
-- What this migration does:
--   resolve_order_issue_atomic() locks the order and escrow rows, validates
--   the buyer and order/escrow state, sets escrows.status = 'dispute' and
--   orders.status = 'cancelled', performs the ESCROW_REFUND and
--   DELIVERY_PAYMENT (or partner_wallets) ledger movements, and returns the
--   breakdown in the same Postgres transaction. A failure anywhere rolls
--   everything back.
--
--   This is additive-only: it only creates one new function.
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION resolve_order_issue_atomic(
  p_order_id UUID,
  p_reason TEXT,
  p_user_id UUID,
  p_description TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order RECORD;
  v_escrow RECORD;
  v_refund_amount DECIMAL(18,6);
  v_delivery_amount DECIMAL(18,6);
  v_rider_paid DECIMAL(18,6);
  v_refund_result RECORD;
  v_rider_result RECORD;
  v_partner_id UUID;
  v_platform_user_id UUID := '00000000-0000-4000-8000-000000000002'::UUID;
BEGIN
  -- 1. Lock and fetch order + escrow.
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
      'error', 'Only the buyer can report an issue for this order',
      'error_code', 'UNAUTHORIZED'
    );
  END IF;

  IF v_order.status != 'delivered' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Can only report issues for delivered orders',
      'error_code', 'NOT_DELIVERED'
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

  IF v_escrow.auto_release_at IS NOT NULL AND NOW() > v_escrow.auto_release_at THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Dispute window has expired. Funds have been released.',
      'error_code', 'DISPUTE_EXPIRED'
    );
  END IF;

  v_refund_amount := ROUND((COALESCE(v_order.total_amount, 0) - COALESCE(v_order.delivery_fee, 0))::NUMERIC, 6);
  v_delivery_amount := ROUND(COALESCE(v_order.delivery_fee, 0)::NUMERIC, 6);
  v_rider_paid := 0;

  -- 2. Refund buyer (only if there is an amount to refund).
  IF v_refund_amount > 0 THEN
    SELECT * INTO v_refund_result
    FROM process_wallet_transaction(
      v_order.buyer_id,
      'escrow_refund',
      v_refund_amount,
      format('Refund for order %s (issue reported)', v_order.order_number),
      p_order_id::TEXT,
      'order'
    );

    IF NOT v_refund_result.success THEN
      RAISE EXCEPTION 'Failed to refund buyer for order %: %', v_order.order_number, v_refund_result.error_message;
    END IF;
  END IF;

  -- 3. Pay rider / partner their delivery fee.
  IF v_delivery_amount > 0 AND v_order.rider_id IS NOT NULL THEN
    SELECT company_id INTO v_partner_id
    FROM verified_riders
    WHERE user_id = v_order.rider_id
      AND verification_status = 'active'
      AND company_id IS NOT NULL
    LIMIT 1;

    IF v_partner_id IS NOT NULL THEN
      INSERT INTO partner_wallets AS pw (
        partner_id, available_balance, pending_withdrawal, total_earned,
        total_withdrawn, preferred_currency, created_at, updated_at
      )
      VALUES (
        v_partner_id, ROUND(v_delivery_amount::NUMERIC, 2), 0,
        ROUND(v_delivery_amount::NUMERIC, 2), 0, 'NGN', NOW(), NOW()
      )
      ON CONFLICT (partner_id)
      DO UPDATE SET
        available_balance = pw.available_balance + ROUND(EXCLUDED.available_balance, 2),
        total_earned = pw.total_earned + ROUND(EXCLUDED.total_earned, 2),
        updated_at = NOW();

      v_rider_paid := v_delivery_amount;
    ELSE
      SELECT * INTO v_rider_result
      FROM process_wallet_transaction(
        v_order.rider_id,
        'delivery_payment',
        v_delivery_amount,
        format('Delivery fee for order %s', v_order.order_number),
        p_order_id::TEXT,
        'order'
      );

      IF NOT v_rider_result.success THEN
        RAISE EXCEPTION 'Failed to pay rider for order %: %', v_order.order_number, v_rider_result.error_message;
      END IF;

      v_rider_paid := v_delivery_amount;
    END IF;
  END IF;

  -- 4. Update order and escrow status in the same transaction.
  UPDATE escrows
  SET
    status = 'dispute',
    auto_release_at = NULL,
    dispute_reason = p_reason,
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
    updated_at = NOW()
  WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'success', true,
    'order', jsonb_build_object(
      'id', v_order.id,
      'order_number', v_order.order_number,
      'buyer_id', v_order.buyer_id,
      'vendor_id', v_order.vendor_id,
      'rider_id', v_order.rider_id,
      'status', 'cancelled'
    ),
    'escrow', jsonb_build_object(
      'id', v_escrow.id,
      'status', 'dispute',
      'refund_amount', v_refund_amount,
      'rider_paid', v_rider_paid
    )
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error in resolve_order_issue_atomic: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during order issue resolution',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION resolve_order_issue_atomic IS
'Atomically resolves a buyer-reported order issue: sets escrow to dispute, cancels the order, refunds the buyer, and pays the rider/partner in a single Postgres transaction.';

REVOKE ALL ON FUNCTION resolve_order_issue_atomic(UUID, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_order_issue_atomic(UUID, TEXT, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION resolve_order_issue_atomic(UUID, TEXT, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION resolve_order_issue_atomic(UUID, TEXT, UUID, TEXT) TO service_role;
ALTER FUNCTION resolve_order_issue_atomic(UUID, TEXT, UUID, TEXT) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'resolve_order_issue_atomic(uuid,text,uuid,text)', 'EXECUTE') as issue_ok,
--        has_function_privilege('authenticated', 'resolve_order_issue_atomic(uuid,text,uuid,text)', 'EXECUTE') as issue_auth_ok;
--
-- Expected: issue_ok = true, issue_auth_ok = false.
--
-- Next step: replace the multi-call sequence in
-- OrdersService.reportIssue() with a single call to this RPC.
-- =====================================================
