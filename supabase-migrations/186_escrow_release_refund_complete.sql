-- =====================================================
-- Migration: 186
-- FINAL atomic consolidation for escrow financial flows.
--
-- 1. Replaces release_escrow_atomic() so the entire release is one
--    Postgres transaction: escrow row lock + wallet credits to
--    vendor/rider/platform + partner wallet credit + buyer escrow
--    debit + escrow status update.
--
-- 2. Adds refund_escrow_atomic() so a full refund is one Postgres
--    transaction: escrow row lock + wallet refund / gift-card
--    reversal + escrow status update.
--
-- Background (the bugs this fixes):
--   EscrowService.releaseEscrow() currently does:
--     1. release_escrow_atomic() - locks and updates escrow to 'released'
--     2. processWalletTransaction('escrow_release') - credits vendor
--     3. partnersWalletService.creditPartnerForDelivery() OR
--        processWalletTransaction('delivery_payment') - credits rider
--     4. processWalletTransaction('platform_commission') - credits platform
--     5. processWalletTransaction('escrow_release_to_platform') - debits buyer
--    Steps 2-5 are outside the escrow row lock. If any wallet call
--    fails, the escrow is already marked 'released' and cannot be
--    retried safely. If a duplicate request races between step 1 and
--    step 5, the same funds can be released twice.
--
--   EscrowService.refundEscrow() currently does:
--     1. processWalletTransaction('escrow_refund') OR giftCardService.refundGiftCard()
--     2. UPDATE escrows SET status='refunded' WHERE status='held'
--    If step 2 fails after the wallet is refunded, the escrow stays
--    'held' and a retry refunds the buyer a second time.
--
-- What this migration does:
--   Both functions lock the escrow row FOR UPDATE and do all money
--   movements inside the same transaction, then update the escrow
--   status. A failure anywhere rolls everything back. Concurrent
--   calls are serialized by the row lock and the 'held' status guard.
--
--   This is additive-only: no table schema changes; it only recreates
--   the existing release_escrow_atomic and adds a new
--   refund_escrow_atomic function.
-- =====================================================

BEGIN;

-- =====================================================
-- 1. RELEASE
-- =====================================================

DROP FUNCTION IF EXISTS release_escrow_atomic(UUID, TEXT, UUID);
DROP FUNCTION IF EXISTS release_escrow_atomic(UUID, TEXT);
DROP FUNCTION IF EXISTS release_escrow_atomic;

CREATE OR REPLACE FUNCTION release_escrow_atomic(
  p_escrow_id UUID,
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
  v_order_status VARCHAR(50);
  v_delivered_at TIMESTAMP;
  v_order_confirmed_at TIMESTAMP;

  v_authorized BOOLEAN := FALSE;
  v_is_auto_release BOOLEAN := FALSE;
  v_is_buyer_confirmed BOOLEAN := FALSE;

  v_buyer_debit_amount DECIMAL(18,6);
  v_partner_id UUID;
  v_vendor_result RECORD;
  v_rider_result RECORD;
  v_platform_result RECORD;
  v_buyer_result RECORD;
  v_description TEXT;
BEGIN
  -- 1. Lock and fetch escrow + order atomically.
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
    o.rider_id,
    o.status,
    o.delivered_at,
    o.order_confirmed_at
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
    v_rider_id,
    v_order_status,
    v_delivered_at,
    v_order_confirmed_at
  FROM escrows e
  INNER JOIN orders o ON e.order_id = o.id
  WHERE e.id = p_escrow_id
    AND e.status = 'held'
  FOR UPDATE OF e;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Escrow not found or already released',
      'error_code', 'ESCROW_NOT_FOUND'
    );
  END IF;

  -- 2. Authorization check.
  IF p_user_id IS NOT NULL THEN
    IF v_vendor_id = p_user_id THEN
      v_authorized := TRUE;
    ELSIF v_buyer_id = p_user_id THEN
      v_authorized := TRUE;
    ELSIF v_rider_id IS NOT NULL AND v_rider_id = p_user_id THEN
      v_authorized := TRUE;
    END IF;

    IF NOT v_authorized THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Unauthorized - only vendor, buyer, or rider can release escrow',
        'error_code', 'UNAUTHORIZED'
      );
    END IF;
  ELSE
    v_authorized := TRUE;
  END IF;

  -- 3. Validate order not cancelled.
  IF v_order_status = 'cancelled' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Cannot release escrow for cancelled order',
      'error_code', 'ORDER_CANCELLED'
    );
  END IF;

  -- 4. Validate delivery/confirmation for manual releases.
  v_is_auto_release := (p_reason LIKE 'Auto-released%');
  v_is_buyer_confirmed := (p_reason LIKE 'Buyer confirmed%' OR p_reason LIKE 'Buyer manually confirmed%');

  IF NOT v_is_auto_release AND NOT v_is_buyer_confirmed THEN
    IF v_delivered_at IS NULL AND v_order_confirmed_at IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Order must be delivered or confirmed before releasing escrow manually',
        'error_code', 'ORDER_NOT_DELIVERED'
      );
    END IF;
  END IF;

  -- 5. Credit vendor wallet.
  IF v_vendor_amount > 0 THEN
    v_description := format('Escrow release for order %s', v_order_number);
    SELECT * INTO v_vendor_result
    FROM process_wallet_transaction(
      v_vendor_id,
      'escrow_release',
      v_vendor_amount,
      v_description,
      v_order_id::TEXT,
      'order'
    );

    IF NOT v_vendor_result.success THEN
      RAISE EXCEPTION 'Failed to credit vendor wallet for order %: %', v_order_number, v_vendor_result.error_message;
    END IF;
  END IF;

  -- 6. Credit rider. If the rider is linked to a verified logistics
  --    partner, credit partner_wallets; otherwise credit the rider's
  --    personal wallet via delivery_payment.
  IF v_rider_id IS NOT NULL AND v_rider_amount > 0 THEN
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
        v_partner_id, ROUND(v_rider_amount::NUMERIC, 2), 0,
        ROUND(v_rider_amount::NUMERIC, 2), 0, 'NGN', NOW(), NOW()
      )
      ON CONFLICT (partner_id)
      DO UPDATE SET
        available_balance = pw.available_balance + ROUND(EXCLUDED.available_balance, 2),
        total_earned = pw.total_earned + ROUND(EXCLUDED.total_earned, 2),
        updated_at = NOW();
    ELSE
      v_description := format('Delivery fee for order %s', v_order_number);
      SELECT * INTO v_rider_result
      FROM process_wallet_transaction(
        v_rider_id,
        'delivery_payment',
        v_rider_amount,
        v_description,
        v_order_id::TEXT,
        'order'
      );

      IF NOT v_rider_result.success THEN
        RAISE EXCEPTION 'Failed to credit rider wallet for order %: %', v_order_number, v_rider_result.error_message;
      END IF;
    END IF;
  END IF;

  -- 7. Credit platform wallet.
  IF v_platform_amount > 0 THEN
    v_description := format('Platform commission for order %s', v_order_number);
    SELECT * INTO v_platform_result
    FROM process_wallet_transaction(
      v_platform_user_id,
      'platform_commission',
      v_platform_amount,
      v_description,
      v_order_id::TEXT,
      'order'
    );

    IF NOT v_platform_result.success THEN
      RAISE EXCEPTION 'Failed to credit platform wallet for order %: %', v_order_number, v_platform_result.error_message;
    END IF;
  END IF;

  -- 8. Debit buyer's escrow for the full released amount.
  v_buyer_debit_amount := ROUND((v_vendor_amount + v_rider_amount + v_platform_amount)::NUMERIC, 6);

  IF v_buyer_debit_amount > 0 THEN
    v_description := format(
      'Escrow debit for released funds on order %s%s',
      v_order_number,
      CASE WHEN p_reason LIKE 'Admin release:%' THEN ' (resolved by support)' ELSE '' END
    );

    SELECT * INTO v_buyer_result
    FROM process_wallet_transaction(
      v_buyer_id,
      'escrow_release_to_platform',
      v_buyer_debit_amount,
      v_description,
      v_order_id::TEXT,
      'order'
    );

    IF NOT v_buyer_result.success THEN
      RAISE EXCEPTION 'Failed to debit buyer escrow for order %: %', v_order_number, v_buyer_result.error_message;
    END IF;
  END IF;

  -- 9. Update escrow status (still inside the same transaction).
  UPDATE escrows
  SET
    status = 'released',
    released_at = NOW(),
    release_reason = p_reason,
    updated_at = NOW()
  WHERE id = p_escrow_id
    AND status = 'held';

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
      'vendor_amount', v_vendor_amount,
      'rider_amount', v_rider_amount,
      'platform_amount', v_platform_amount,
      'status', 'released'
    ),
    'order', jsonb_build_object(
      'id', v_order_id,
      'order_number', v_order_number,
      'buyer_id', v_buyer_id,
      'vendor_id', v_vendor_id,
      'rider_id', v_rider_id,
      'status', v_order_status,
      'delivered_at', v_delivered_at,
      'order_confirmed_at', v_order_confirmed_at
    )
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error in release_escrow_atomic: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during escrow release',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION release_escrow_atomic IS
'Atomically releases an escrow in a single Postgres transaction: locks the escrow row, credits vendor/rider/platform wallets (partner_wallets for partner riders), debits the buyer escrow balance, and updates the escrow status. All wallet calls are inside the transaction so any failure rolls back the status and all ledger changes.';

REVOKE ALL ON FUNCTION release_escrow_atomic(UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_escrow_atomic(UUID, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION release_escrow_atomic(UUID, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION release_escrow_atomic(UUID, TEXT, UUID) TO service_role;
ALTER FUNCTION release_escrow_atomic(UUID, TEXT, UUID) SET search_path = public, pg_temp;

-- =====================================================
-- 2. FULL REFUND
-- =====================================================

CREATE OR REPLACE FUNCTION refund_escrow_atomic(
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
  v_escrow_id UUID;
  v_order_id UUID;
  v_order_group_id UUID;
  v_total_amount DECIMAL(18,6);
  v_gift_card_amount DECIMAL(18,6);
  v_escrow_status VARCHAR(50);
  v_payment_source VARCHAR(20);

  v_order_number VARCHAR(50);
  v_buyer_id UUID;
  v_vendor_id UUID;
  v_order_status VARCHAR(50);

  v_authorized BOOLEAN := FALSE;
  v_wallet_refund_amount DECIMAL(18,6);
  v_refund_result RECORD;

  v_gift_card_tx RECORD;
  v_gift_card_id UUID;
  v_gift_card_user_id UUID;
  v_original_reservation_ref TEXT;
  v_gift_card_record RECORD;
  v_gift_card_new_balance DECIMAL(18,6);
  v_gift_card_reverse_ref TEXT;
  v_escrow_release_result RECORD;
  v_reserve_restore_result RECORD;
BEGIN
  -- 1. Lock and fetch escrow + order.
  SELECT
    e.id,
    e.order_id,
    e.total_amount,
    e.gift_card_amount,
    e.status,
    e.payment_source,
    o.order_number,
    o.buyer_id,
    o.vendor_id,
    o.status,
    o.order_group_id
  INTO
    v_escrow_id,
    v_order_id,
    v_total_amount,
    v_gift_card_amount,
    v_escrow_status,
    v_payment_source,
    v_order_number,
    v_buyer_id,
    v_vendor_id,
    v_order_status,
    v_order_group_id
  FROM escrows e
  INNER JOIN orders o ON e.order_id = o.id
  WHERE e.id = p_escrow_id
    AND e.status = 'held'
  FOR UPDATE OF e;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Escrow not found or already processed',
      'error_code', 'ESCROW_NOT_FOUND'
    );
  END IF;

  -- 2. Authorization check (buyer or vendor only for refunds).
  IF p_user_id IS NOT NULL THEN
    IF v_buyer_id = p_user_id OR v_vendor_id = p_user_id THEN
      v_authorized := TRUE;
    END IF;

    IF NOT v_authorized THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Unauthorized - only buyer or vendor can refund escrow',
        'error_code', 'UNAUTHORIZED'
      );
    END IF;
  ELSE
    v_authorized := TRUE;
  END IF;

  -- 3. Wallet portion: refund directly to buyer's available balance.
  v_wallet_refund_amount := CASE
    WHEN v_payment_source = 'mixed' THEN v_total_amount - COALESCE(v_gift_card_amount, 0)
    WHEN v_payment_source = 'wallet' THEN v_total_amount
    ELSE 0
  END;

  IF v_wallet_refund_amount > 0 THEN
    SELECT * INTO v_refund_result
    FROM process_wallet_transaction(
      v_buyer_id,
      'escrow_refund',
      v_wallet_refund_amount,
      format('Refund for order %s: %s', v_order_number, p_reason),
      v_order_id::TEXT,
      'order'
    );

    IF NOT v_refund_result.success THEN
      RAISE EXCEPTION 'Failed to refund buyer wallet for order %: %', v_order_number, v_refund_result.error_message;
    END IF;
  END IF;

  -- 4. Gift card portion: reverse the original redemption.
  IF v_payment_source IN ('gift_card', 'mixed') AND COALESCE(v_gift_card_amount, 0) > 0 THEN
    -- 4a. Find the original redeem/partial_redeem transaction.
    SELECT * INTO v_gift_card_tx
    FROM gift_card_transactions
    WHERE transaction_type IN ('redeem', 'partial_redeem')
      AND order_id = v_order_id
    LIMIT 1;

    IF NOT FOUND AND v_order_group_id IS NOT NULL THEN
      SELECT * INTO v_gift_card_tx
      FROM gift_card_transactions
      WHERE transaction_type IN ('redeem', 'partial_redeem')
        AND metadata->>'order_group_id' = v_order_group_id::TEXT
      LIMIT 1;
    END IF;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Gift card redeem transaction not found for order %', v_order_number;
    END IF;

    v_gift_card_id := v_gift_card_tx.gift_card_id;

    SELECT * INTO v_gift_card_record
    FROM gift_cards
    WHERE id = v_gift_card_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Gift card % not found for refund', v_gift_card_id;
    END IF;

    v_gift_card_user_id := COALESCE(v_gift_card_tx.user_id, v_gift_card_record.recipient_user_id, v_buyer_id);
    v_original_reservation_ref := v_gift_card_tx.metadata->>'reservation_ref';
    v_gift_card_reverse_ref := COALESCE(v_original_reservation_ref, v_gift_card_tx.id::TEXT);

    -- 4b. Release the buyer's escrow hold for the gift card portion.
    SELECT * INTO v_escrow_release_result
    FROM process_wallet_transaction(
      v_gift_card_user_id,
      'gift_card_escrow_hold',
      -v_gift_card_amount,
      format('Gift card refund for order %s: %s', v_order_number, p_reason),
      v_gift_card_reverse_ref,
      'gift_card_refund'
    );

    IF NOT v_escrow_release_result.success THEN
      RAISE EXCEPTION 'Failed to release gift card escrow hold for order %: %', v_order_number, v_escrow_release_result.error_message;
    END IF;

    -- 4c. Restore the marketing/reserve wallet that backed the card.
    SELECT * INTO v_reserve_restore_result
    FROM process_wallet_transaction(
      p_admin_gift_user_id,
      'gift_card_purchase',
      v_gift_card_amount,
      format('Gift card refund reserve restore for order %s: %s', v_order_number, p_reason),
      v_gift_card_reverse_ref,
      'gift_card_refund'
    );

    IF NOT v_reserve_restore_result.success THEN
      RAISE EXCEPTION 'Failed to restore gift card reserve for order %: %', v_order_number, v_reserve_restore_result.error_message;
    END IF;

    -- 4d. Restore the gift card balance.
    v_gift_card_new_balance := v_gift_card_record.current_balance + v_gift_card_amount;

    UPDATE gift_cards
    SET
      current_balance = v_gift_card_new_balance,
      status = 'claimed',
      updated_at = NOW()
    WHERE id = v_gift_card_id;

    INSERT INTO gift_card_transactions (
      gift_card_id,
      transaction_type,
      amount,
      balance_after,
      user_id,
      metadata
    )
    VALUES (
      v_gift_card_id,
      'admin_adjust',
      v_gift_card_amount,
      v_gift_card_new_balance,
      v_gift_card_user_id,
      jsonb_build_object(
        'reason', p_reason,
        'order_id', v_order_id,
        'refund', true,
        'reversed_transaction_id', v_gift_card_tx.id,
        'reservation_ref', v_gift_card_reverse_ref
      )
    );
  END IF;

  -- 5. Update escrow status to refunded.
  UPDATE escrows
  SET
    status = 'refunded',
    refund_reason = p_reason,
    updated_at = NOW()
  WHERE id = p_escrow_id
    AND status = 'held';

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
      'status', 'refunded'
    ),
    'order', jsonb_build_object(
      'id', v_order_id,
      'order_number', v_order_number,
      'buyer_id', v_buyer_id,
      'vendor_id', v_vendor_id,
      'status', v_order_status
    )
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error in refund_escrow_atomic: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during escrow refund',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION refund_escrow_atomic IS
'Atomically refunds an escrow in a single Postgres transaction: locks the escrow row, refunds the wallet portion (escrow_refund), reverses the gift card portion (escrow hold release + reserve restore + gift_cards balance restore), and updates the escrow status. All money movements and the status update are all-or-nothing.';

REVOKE ALL ON FUNCTION refund_escrow_atomic(UUID, TEXT, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION refund_escrow_atomic(UUID, TEXT, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION refund_escrow_atomic(UUID, TEXT, UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION refund_escrow_atomic(UUID, TEXT, UUID, UUID) TO service_role;
ALTER FUNCTION refund_escrow_atomic(UUID, TEXT, UUID, UUID) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'release_escrow_atomic(uuid,text,uuid)', 'EXECUTE') as release_ok,
--        has_function_privilege('authenticated', 'release_escrow_atomic(uuid,text,uuid)', 'EXECUTE') as release_auth_ok,
--        has_function_privilege('service_role', 'refund_escrow_atomic(uuid,text,uuid,uuid)', 'EXECUTE') as refund_ok,
--        has_function_privilege('authenticated', 'refund_escrow_atomic(uuid,text,uuid,uuid)', 'EXECUTE') as refund_auth_ok;
--
-- Expected: service_role EXECUTE = true for both; authenticated = false for both.
--
-- Next step: simplify EscrowService.releaseEscrow() and refundEscrow() to
-- call these RPCs once, then handle order status and notifications outside.
-- =====================================================
