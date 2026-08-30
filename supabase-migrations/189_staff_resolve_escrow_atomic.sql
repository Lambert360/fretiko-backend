-- =====================================================
-- Migration: 189
-- Add staff_resolve_escrow_atomic(): a single RPC that atomically
-- performs a staff-initiated partial resolution: refund buyer, pay vendor,
-- pay rider (partner or wallet), pay platform, debit buyer escrow, and
-- update escrow/order status.
--
-- Background (the bug this fixes):
--   AdminService.processPartialRefund() currently does 5 separate wallet
--   calls and only then updates escrows and orders. If a call succeeds but
--   the final UPDATE fails, the money has moved but the escrow still
--   appears 'held'/'dispute', allowing a retry to double-refund/pay.
--
-- What this migration does:
--   staff_resolve_escrow_atomic() locks the escrow and order rows, validates
--   the staff-provided allocation, executes all wallet/partner ledger
--   movements, debits the buyer's escrow, updates escrows.status to
--   'refunded' and orders.status to 'cancelled', and returns the breakdown.
--   A failure anywhere rolls everything back. The row lock and the status
--   guard prevent concurrent resolutions.
--
--   This is additive-only: it only creates one new function.
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION staff_resolve_escrow_atomic(
  p_escrow_id UUID,
  p_vendor_amount NUMERIC,
  p_rider_earnings NUMERIC,
  p_platform_fee NUMERIC,
  p_reason TEXT,
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_platform_user_id UUID := '00000000-0000-4000-8000-000000000002'::UUID;

  v_escrow_id UUID;
  v_order_id UUID;
  v_total_amount DECIMAL(18,6);
  v_escrow_status VARCHAR(50);

  v_order_number VARCHAR(50);
  v_buyer_id UUID;
  v_vendor_id UUID;
  v_rider_id UUID;

  v_vendor_amount DECIMAL(18,6);
  v_rider_earnings DECIMAL(18,6);
  v_platform_fee DECIMAL(18,6);
  v_total_allocated DECIMAL(18,6);
  v_buyer_refund DECIMAL(18,6);
  v_buyer_debit DECIMAL(18,6);

  v_partner_id UUID;
  v_buyer_result RECORD;
  v_vendor_result RECORD;
  v_rider_result RECORD;
  v_platform_result RECORD;
  v_debit_result RECORD;
  v_description TEXT;
BEGIN
  -- 1. Round inputs and validate non-negativity.
  v_vendor_amount := ROUND(COALESCE(p_vendor_amount, 0)::NUMERIC, 6);
  v_rider_earnings := ROUND(COALESCE(p_rider_earnings, 0)::NUMERIC, 6);
  v_platform_fee := ROUND(COALESCE(p_platform_fee, 0)::NUMERIC, 6);

  IF v_vendor_amount < 0 OR v_rider_earnings < 0 OR v_platform_fee < 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Allocation amounts cannot be negative',
      'error_code', 'NEGATIVE_ALLOCATION'
    );
  END IF;

  -- 2. Lock and fetch escrow + order.
  SELECT
    e.id,
    e.order_id,
    e.total_amount,
    e.status,
    o.order_number,
    o.buyer_id,
    o.vendor_id,
    o.rider_id
  INTO
    v_escrow_id,
    v_order_id,
    v_total_amount,
    v_escrow_status,
    v_order_number,
    v_buyer_id,
    v_vendor_id,
    v_rider_id
  FROM escrows e
  INNER JOIN orders o ON e.order_id = o.id
  WHERE e.id = p_escrow_id
    AND e.status IN ('held', 'dispute')
  FOR UPDATE OF e;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Escrow not found or already processed',
      'error_code', 'ESCROW_NOT_FOUND'
    );
  END IF;

  -- 3. Validate allocation does not exceed total.
  v_total_allocated := v_vendor_amount + v_rider_earnings + v_platform_fee;
  IF v_total_allocated > v_total_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Allocated %s exceeds escrow total %s', v_total_allocated, v_total_amount),
      'error_code', 'OVER_ALLOCATION'
    );
  END IF;

  v_buyer_refund := ROUND((v_total_amount - v_total_allocated)::NUMERIC, 6);

  -- 4. Refund buyer.
  IF v_buyer_refund > 0 THEN
    SELECT * INTO v_buyer_result
    FROM process_wallet_transaction(
      v_buyer_id,
      'escrow_refund',
      v_buyer_refund,
      format('Partial refund for order %s (resolved by support)', v_order_number),
      v_order_id::TEXT,
      'order'
    );

    IF NOT v_buyer_result.success THEN
      RAISE EXCEPTION 'Failed to refund buyer for order %: %', v_order_number, v_buyer_result.error_message;
    END IF;
  END IF;

  -- 5. Credit vendor.
  IF v_vendor_amount > 0 THEN
    SELECT * INTO v_vendor_result
    FROM process_wallet_transaction(
      v_vendor_id,
      'escrow_release',
      v_vendor_amount,
      format('Partial payment for order %s (resolved by support)', v_order_number),
      v_order_id::TEXT,
      'order'
    );

    IF NOT v_vendor_result.success THEN
      RAISE EXCEPTION 'Failed to credit vendor for order %: %', v_order_number, v_vendor_result.error_message;
    END IF;
  END IF;

  -- 6. Pay rider earnings if a rider is assigned.
  IF v_rider_earnings > 0 AND v_rider_id IS NOT NULL THEN
    SELECT company_id INTO v_partner_id
    FROM verified_riders
    WHERE user_id = v_rider_id
      AND verification_status = 'active'
      AND company_id IS NOT NULL
    LIMIT 1;

    IF v_partner_id IS NOT NULL THEN
      INSERT INTO partner_wallets AS pw (
        partner_id, available_balance, pending_withdrawal, total_earned,
        total_withdrawn, preferred_currency, created_at, updated_at
      )
      VALUES (
        v_partner_id, ROUND(v_rider_earnings::NUMERIC, 2), 0,
        ROUND(v_rider_earnings::NUMERIC, 2), 0, 'NGN', NOW(), NOW()
      )
      ON CONFLICT (partner_id)
      DO UPDATE SET
        available_balance = pw.available_balance + ROUND(EXCLUDED.available_balance, 2),
        total_earned = pw.total_earned + ROUND(EXCLUDED.total_earned, 2),
        updated_at = NOW();
    ELSE
      v_description := format('Earnings for order %s (resolved by support)', v_order_number);
      SELECT * INTO v_rider_result
      FROM process_wallet_transaction(
        v_rider_id,
        'delivery_payment',
        v_rider_earnings,
        v_description,
        v_order_id::TEXT,
        'order'
      );

      IF NOT v_rider_result.success THEN
        RAISE EXCEPTION 'Failed to credit rider for order %: %', v_order_number, v_rider_result.error_message;
      END IF;
    END IF;
  ELSIF v_rider_earnings > 0 AND v_rider_id IS NULL THEN
    -- No rider assigned but staff supplied rider earnings — add them to buyer refund.
    v_buyer_refund := ROUND((v_buyer_refund + v_rider_earnings)::NUMERIC, 6);
  END IF;

  -- 7. Credit platform fee.
  IF v_platform_fee > 0 THEN
    SELECT * INTO v_platform_result
    FROM process_wallet_transaction(
      v_platform_user_id,
      'platform_commission',
      v_platform_fee,
      format('Platform fee for order %s (resolved by support)', v_order_number),
      v_order_id::TEXT,
      'order'
    );

    IF NOT v_platform_result.success THEN
      RAISE EXCEPTION 'Failed to credit platform for order %: %', v_order_number, v_platform_result.error_message;
    END IF;
  END IF;

  -- 8. Debit buyer's escrow for the released portion.
  v_buyer_debit := v_vendor_amount + v_rider_earnings + v_platform_fee;

  IF v_buyer_debit > 0 THEN
    SELECT * INTO v_debit_result
    FROM process_wallet_transaction(
      v_buyer_id,
      'escrow_release_to_platform',
      v_buyer_debit,
      format('Escrow debit for released funds on order %s (resolved by support)', v_order_number),
      v_order_id::TEXT,
      'order'
    );

    IF NOT v_debit_result.success THEN
      RAISE EXCEPTION 'Failed to debit buyer escrow for order %: %', v_order_number, v_debit_result.error_message;
    END IF;
  END IF;

  -- 9. Update escrow and order status in the same transaction.
  UPDATE escrows
  SET
    status = 'refunded',
    refund_reason = p_reason,
    updated_at = NOW()
  WHERE id = p_escrow_id
    AND status IN ('held', 'dispute');

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
  WHERE id = v_order_id;

  RETURN jsonb_build_object(
    'success', true,
    'escrow', jsonb_build_object(
      'id', v_escrow_id,
      'order_id', v_order_id,
      'total_amount', v_total_amount,
      'buyer_refund', v_buyer_refund,
      'vendor_released', v_vendor_amount,
      'rider_earnings', v_rider_earnings,
      'platform_fee', v_platform_fee,
      'status', 'refunded'
    ),
    'order', jsonb_build_object(
      'id', v_order_id,
      'order_number', v_order_number,
      'buyer_id', v_buyer_id,
      'vendor_id', v_vendor_id,
      'rider_id', v_rider_id
    )
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error in staff_resolve_escrow_atomic: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during staff escrow resolution',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION staff_resolve_escrow_atomic IS
'Atomically performs a staff-initiated partial escrow resolution: refunds the buyer, credits vendor, rider (or partner_wallets), platform, debits the buyer escrow, and updates escrows and orders status in a single Postgres transaction.';

REVOKE ALL ON FUNCTION staff_resolve_escrow_atomic(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION staff_resolve_escrow_atomic(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION staff_resolve_escrow_atomic(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION staff_resolve_escrow_atomic(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, UUID) TO service_role;
ALTER FUNCTION staff_resolve_escrow_atomic(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, UUID) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'staff_resolve_escrow_atomic(uuid,numeric,numeric,numeric,text,uuid)', 'EXECUTE') as resolve_ok,
--        has_function_privilege('authenticated', 'staff_resolve_escrow_atomic(uuid,numeric,numeric,numeric,text,uuid)', 'EXECUTE') as resolve_auth_ok;
--
-- Expected: resolve_ok = true, resolve_auth_ok = false.
--
-- Next step: replace the multi-call sequence in
-- AdminService.processPartialRefund() with a single call to this RPC.
-- =====================================================
