-- =====================================================
-- Migration: 190
-- Add admin_full_refund_escrow_atomic(): a thin, atomic wrapper around
-- refund_escrow_atomic() that also cancels the linked order inside the
-- same Postgres transaction.
--
-- Background (the bug this fixes):
--   AdminService.processFullRefund() currently calls
--   process_wallet_transaction('escrow_refund') and then separately
--   updates escrows.status and orders.status. If either status update
--   fails after the wallet refund, the money is gone but the order/escrow
--   still appear active/held, allowing a second refund attempt.
--
-- What this migration does:
--   admin_full_refund_escrow_atomic() calls the existing
--   refund_escrow_atomic() (which already atomically handles wallet,
--   gift-card reversal, and escrow status), then updates orders.status
--   to 'cancelled' in the same transaction. A failure anywhere rolls
--   everything back.
--
--   This is additive-only: it only creates one new function.
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION admin_full_refund_escrow_atomic(
  p_escrow_id UUID,
  p_reason TEXT,
  p_admin_gift_user_id UUID,
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_refund_result JSONB;
  v_order_id UUID;
BEGIN
  -- 1. Reuse the existing atomic full refund logic.
  v_refund_result := refund_escrow_atomic(
    p_escrow_id,
    p_reason,
    p_admin_gift_user_id,
    p_user_id
  );

  IF NOT (v_refund_result->>'success')::BOOLEAN THEN
    RETURN v_refund_result;
  END IF;

  v_order_id := ((v_refund_result->'order'->>'id'))::UUID;

  -- 2. Cancel the linked order in the same transaction.
  UPDATE orders
  SET
    status = 'cancelled',
    updated_at = NOW()
  WHERE id = v_order_id;

  RETURN v_refund_result;

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error in admin_full_refund_escrow_atomic: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during admin full refund',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION admin_full_refund_escrow_atomic IS
'Atomically wraps refund_escrow_atomic() and cancels the linked order, ensuring the full admin refund and both escrow/order status updates are in one Postgres transaction.';

REVOKE ALL ON FUNCTION admin_full_refund_escrow_atomic(UUID, TEXT, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_full_refund_escrow_atomic(UUID, TEXT, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION admin_full_refund_escrow_atomic(UUID, TEXT, UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION admin_full_refund_escrow_atomic(UUID, TEXT, UUID, UUID) TO service_role;
ALTER FUNCTION admin_full_refund_escrow_atomic(UUID, TEXT, UUID, UUID) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'admin_full_refund_escrow_atomic(uuid,text,uuid,uuid)', 'EXECUTE') as refund_ok,
--        has_function_privilege('authenticated', 'admin_full_refund_escrow_atomic(uuid,text,uuid,uuid)', 'EXECUTE') as refund_auth_ok;
--
-- Expected: refund_ok = true, refund_auth_ok = false.
--
-- Next step: replace the multi-call sequence in
-- AdminService.processFullRefund() with a single call to this RPC.
-- =====================================================
