-- =====================================================
-- Migration: 188
-- Add split_escrow_amount_atomic(): a single RPC that atomically
-- splits an escrow between buyer and vendor/rider/platform.
--
-- Background (the bug this fixes):
--   EscrowService.splitEscrowAmount() currently does:
--     1. processWalletTransaction('escrow_refund') - refund buyer
--     2. Calculate proportional vendor/rider/platform from remaining
--     3. processWalletTransaction('escrow_release') - credit vendor
--     4. processWalletTransaction('delivery_payment') or partner_wallets - credit rider
--     5. processWalletTransaction('platform_commission') - credit platform
--     6. processWalletTransaction('escrow_release_to_platform') - debit buyer escrow
--     7. UPDATE escrows SET status='released'
--   Steps 1-6 are outside the escrow row lock. If the final UPDATE fails
--   after the wallet calls, the same escrow can be split again.
--
-- What this migration does:
--   split_escrow_amount_atomic() locks the escrow row, validates the
--   split, refunds the buyer, credits vendor/rider/platform (with partner
--   support), debits the buyer's escrow, and updates the escrow status in
--   one Postgres transaction. A failure rolls everything back.
--
--   This is additive-only: it only creates one new function.
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION split_escrow_amount_atomic(
  p_escrow_id UUID,
  p_buyer_amount NUMERIC,
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
  v_vendor_amount DECIMAL(18,6);
  v_rider_amount DECIMAL(18,6);
  v_platform_amount DECIMAL(18,6);
  v_escrow_status VARCHAR(50);

  v_order_number VARCHAR(50);
  v_buyer_id UUID;
  v_vendor_id UUID;
  v_rider_id UUID;

  v_authorized BOOLEAN := FALSE;
  v_buyer_amount DECIMAL(18,6);
  v_vendor_remaining DECIMAL(18,6);
  v_total_proportion NUMERIC;
  v_vendor_proportion NUMERIC;
  v_rider_proportion NUMERIC;
  v_platform_proportion NUMERIC;
  v_vendor_release DECIMAL(18,6);
  v_rider_release DECIMAL(18,6);
  v_platform_release DECIMAL(18,6);
  v_buyer_debit DECIMAL(18,6);
  v_partner_id UUID;
  v_refund_result RECORD;
  v_vendor_result RECORD;
  v_rider_result RECORD;
  v_platform_result RECORD;
  v_buyer_result RECORD;
  v_description TEXT;
BEGIN
  -- 1. Validate buyer amount.
  IF p_buyer_amount IS NULL OR p_buyer_amount < 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Buyer amount cannot be negative',
      'error_code', 'INVALID_BUYER_AMOUNT'
    );
  END IF;

  v_buyer_amount := ROUND(p_buyer_amount::NUMERIC, 6);

  -- 2. Lock and fetch escrow + order.
  SELECT
    e.id,
    e.order_id,
    e.total_amount,
    e.vendor_amount,
    e.rider_amount,
    e.platform_amount,
    e.status,
    o.order_number,
    o.buyer_id,
    o.vendor_id,
    o.rider_id
  INTO
    v_escrow_id,
    v_order_id,
    v_total_amount,
    v_vendor_amount,
    v_rider_amount,
    v_platform_amount,
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

  IF v_buyer_amount > v_total_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Buyer amount %s exceeds escrow total %s', v_buyer_amount, v_total_amount),
      'error_code', 'AMOUNT_EXCEEDS_TOTAL'
    );
  END IF;

  -- 3. Authorization check (buyer or vendor if userId provided).
  IF p_user_id IS NOT NULL THEN
    IF v_buyer_id = p_user_id OR v_vendor_id = p_user_id THEN
      v_authorized := TRUE;
    END IF;

    IF NOT v_authorized THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Unauthorized - only buyer or vendor can split escrow',
        'error_code', 'UNAUTHORIZED'
      );
    END IF;
  ELSE
    v_authorized := TRUE;
  END IF;

  v_vendor_remaining := ROUND((v_total_amount - v_buyer_amount)::NUMERIC, 6);

  -- 4. Refund buyer their portion.
  IF v_buyer_amount > 0 THEN
    SELECT * INTO v_refund_result
    FROM process_wallet_transaction(
      v_buyer_id,
      'escrow_refund',
      v_buyer_amount,
      format('Split resolution for order %s: %s', v_order_number, p_reason),
      v_order_id::TEXT,
      'order'
    );

    IF NOT v_refund_result.success THEN
      RAISE EXCEPTION 'Failed to refund buyer for order %: %', v_order_number, v_refund_result.error_message;
    END IF;
  END IF;

  -- 5. Proportional release of the remaining amount.
  IF v_vendor_remaining > 0 THEN
    v_vendor_proportion := v_vendor_amount / NULLIF(v_total_amount, 0);
    v_rider_proportion := v_rider_amount / NULLIF(v_total_amount, 0);
    v_platform_proportion := v_platform_amount / NULLIF(v_total_amount, 0);

    IF v_vendor_proportion IS NULL THEN v_vendor_proportion := 0; END IF;
    IF v_rider_proportion IS NULL THEN v_rider_proportion := 0; END IF;
    IF v_platform_proportion IS NULL THEN v_platform_proportion := 0; END IF;

    v_total_proportion := v_vendor_proportion + v_rider_proportion + v_platform_proportion;

    IF v_total_proportion = 0 THEN
      -- Edge case: no breakdown proportions. Give everything to vendor.
      v_vendor_release := v_vendor_remaining;
      v_rider_release := 0;
      v_platform_release := 0;
    ELSE
      v_vendor_release := ROUND((v_vendor_remaining * (v_vendor_proportion / v_total_proportion))::NUMERIC, 6);
      v_rider_release := ROUND((v_vendor_remaining * (v_rider_proportion / v_total_proportion))::NUMERIC, 6);
      v_platform_release := ROUND((v_vendor_remaining - v_vendor_release - v_rider_release)::NUMERIC, 6);
    END IF;

    -- 5a. Credit vendor.
    IF v_vendor_release > 0 THEN
      v_description := format('Split escrow release for order %s: %s', v_order_number, p_reason);
      SELECT * INTO v_vendor_result
      FROM process_wallet_transaction(
        v_vendor_id,
        'escrow_release',
        v_vendor_release,
        v_description,
        v_order_id::TEXT,
        'order'
      );

      IF NOT v_vendor_result.success THEN
        RAISE EXCEPTION 'Failed to credit vendor for order %: %', v_order_number, v_vendor_result.error_message;
      END IF;
    END IF;

    -- 5b. Credit rider / partner.
    IF v_rider_id IS NOT NULL AND v_rider_release > 0 THEN
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
          v_partner_id, ROUND(v_rider_release::NUMERIC, 2), 0,
          ROUND(v_rider_release::NUMERIC, 2), 0, 'NGN', NOW(), NOW()
        )
        ON CONFLICT (partner_id)
        DO UPDATE SET
          available_balance = pw.available_balance + ROUND(EXCLUDED.available_balance, 2),
          total_earned = pw.total_earned + ROUND(EXCLUDED.total_earned, 2),
          updated_at = NOW();
      ELSE
        v_description := format('Delivery fee for order %s (split resolution)', v_order_number);
        SELECT * INTO v_rider_result
        FROM process_wallet_transaction(
          v_rider_id,
          'delivery_payment',
          v_rider_release,
          v_description,
          v_order_id::TEXT,
          'order'
        );

        IF NOT v_rider_result.success THEN
          RAISE EXCEPTION 'Failed to credit rider for order %: %', v_order_number, v_rider_result.error_message;
        END IF;
      END IF;
    END IF;

    -- 5c. Credit platform.
    IF v_platform_release > 0 THEN
      v_description := format('Platform commission for order %s (split resolution)', v_order_number);
      SELECT * INTO v_platform_result
      FROM process_wallet_transaction(
        v_platform_user_id,
        'platform_commission',
        v_platform_release,
        v_description,
        v_order_id::TEXT,
        'order'
      );

      IF NOT v_platform_result.success THEN
        RAISE EXCEPTION 'Failed to credit platform for order %: %', v_order_number, v_platform_result.error_message;
      END IF;
    END IF;

    -- 5d. Debit buyer's escrow for the released remainder.
    v_buyer_debit := v_vendor_release + v_rider_release + v_platform_release;

    IF v_buyer_debit > 0 THEN
      v_description := format('Escrow debit for released funds on order %s (split resolution)', v_order_number);
      SELECT * INTO v_buyer_result
      FROM process_wallet_transaction(
        v_buyer_id,
        'escrow_release_to_platform',
        v_buyer_debit,
        v_description,
        v_order_id::TEXT,
        'order'
      );

      IF NOT v_buyer_result.success THEN
        RAISE EXCEPTION 'Failed to debit buyer escrow for order %: %', v_order_number, v_buyer_result.error_message;
      END IF;
    END IF;
  END IF;

  -- 6. Update escrow status.
  UPDATE escrows
  SET
    status = 'released',
    released_at = NOW(),
    release_reason = format(
      'Split resolution: %s. Buyer: ₣%s, Vendor: ₣%s, Rider: ₣%s, Platform: ₣%s',
      p_reason, v_buyer_amount, v_vendor_release, v_rider_release, v_platform_release
    ),
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

  RETURN jsonb_build_object(
    'success', true,
    'escrow', jsonb_build_object(
      'id', v_escrow_id,
      'order_id', v_order_id,
      'total_amount', v_total_amount,
      'buyer_amount', v_buyer_amount,
      'vendor_released', v_vendor_release,
      'rider_released', v_rider_release,
      'platform_released', v_platform_release,
      'status', 'released'
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
    RAISE WARNING 'Error in split_escrow_amount_atomic: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during split resolution',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION split_escrow_amount_atomic IS
'Atomically splits an escrow between buyer and vendor/rider/platform: refunds the buyer portion, releases the remainder proportionally (with partner_wallets support for partner riders), debits the buyer escrow, and updates the escrow status in a single Postgres transaction.';

REVOKE ALL ON FUNCTION split_escrow_amount_atomic(UUID, NUMERIC, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION split_escrow_amount_atomic(UUID, NUMERIC, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION split_escrow_amount_atomic(UUID, NUMERIC, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION split_escrow_amount_atomic(UUID, NUMERIC, TEXT, UUID) TO service_role;
ALTER FUNCTION split_escrow_amount_atomic(UUID, NUMERIC, TEXT, UUID) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'split_escrow_amount_atomic(uuid,numeric,text,uuid)', 'EXECUTE') as split_ok,
--        has_function_privilege('authenticated', 'split_escrow_amount_atomic(uuid,numeric,text,uuid)', 'EXECUTE') as split_auth_ok;
--
-- Expected: split_ok = true, split_auth_ok = false.
--
-- Next step: replace the multi-call sequence in
-- EscrowService.splitEscrowAmount() with a single call to this RPC.
-- =====================================================
