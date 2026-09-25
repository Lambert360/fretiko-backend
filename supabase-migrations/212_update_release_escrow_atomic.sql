-- =====================================================
-- Migration: 212
-- Update release_escrow_atomic() to:
--   1. Carry order.source and order.metadata through the release function.
--   2. Credit interstate logistics partners from order.metadata->'interstate_delivery'
--      when no rider is assigned but a rider/partner amount is held in escrow.
--   3. Add an explicit auction delivery gate so auction escrows can only be released
--      once the order has been marked delivered.
-- =====================================================

BEGIN;

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
  v_order_source VARCHAR(50);
  v_order_metadata JSONB;
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
    o.source,
    o.metadata,
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
    v_order_source,
    v_order_metadata,
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

  -- 4b. Hard auction delivery gate: auction orders require delivered_at.
  IF v_order_source = 'auction' AND v_delivered_at IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Auction orders require delivery before escrow release',
      'error_code', 'ORDER_NOT_DELIVERED'
    );
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
  --    If there is no rider but a partner is stored in metadata (interstate delivery),
  --    credit that partner wallet instead.
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
  ELSIF v_rider_amount > 0 THEN
    -- 6b. Credit interstate logistics partner if there is no rider but a partner is in metadata.
    v_partner_id := (v_order_metadata->'interstate_delivery'->>'companyId')::UUID;

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
'Atomically releases an escrow in a single Postgres transaction: locks the escrow row, credits vendor/rider/platform wallets (or partner_wallets for partner riders / interstate logistics partners), debits the buyer escrow balance, and updates the escrow status. Auction orders require delivered_at to be set.';

REVOKE ALL ON FUNCTION release_escrow_atomic(UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_escrow_atomic(UUID, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION release_escrow_atomic(UUID, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION release_escrow_atomic(UUID, TEXT, UUID) TO service_role;
ALTER FUNCTION release_escrow_atomic(UUID, TEXT, UUID) SET search_path = public, pg_temp;

COMMIT;
