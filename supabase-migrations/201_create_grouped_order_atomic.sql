-- =====================================================
-- Migration: 201
-- Add create_grouped_order_atomic(): a single RPC that atomically
-- creates a grouped multi-vendor checkout, its order_items, decrements
-- product stock, redeems a gift card once for the whole group, holds
-- the buyer's wallet funds once for the accumulated total, and inserts
-- one escrow record per sub-order in one Postgres transaction.
--
-- Background:
--   checkout.service.ts::createGroupedOrder currently performs these
--   steps as separate network calls:
--     1. order_groups insert
--     2. per-vendor orders insert
--     3. per-vendor order_items insert
--     4. per-product stock decrement
--     5. wallet ledger deduction
--     6. per-vendor escrow insert
--   Any failure mid-way can leave money deducted without escrows, or
--   orders without stock. This migration folds the grouped checkout
--   lifecycle into one DB transaction.
--
-- What this migration does:
--   Adds create_grouped_order_atomic() which, in one transaction:
--     1. Validates the p_groups payload.
--     2. For each group, inserts an orders row (generating unique PINs).
--     3. Inserts the group's order_items rows.
--     4. Decrements products.quantity for each stock_updates row.
--     5. Accumulates the total_amount across all groups.
--     6. Redeems the gift card once (if supplied).
--     7. Holds the wallet portion via process_wallet_transaction.
--     8. Updates each created order with payment/reward/gift fields.
--     9. Inserts one escrows row per group using the provided breakdown.
--   If any step fails, the entire transaction rolls back.
--
--   This is additive-only and does not modify existing functions.
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION create_grouped_order_atomic(
  p_buyer_id UUID,
  p_groups JSONB,
  p_gift_card JSONB DEFAULT NULL,
  p_rewards_amount NUMERIC DEFAULT 0,
  p_admin_gift_user_id UUID DEFAULT NULL,
  p_user_ip TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_group JSONB;
  v_group_order JSONB;
  v_group_items JSONB;
  v_group_stock JSONB;
  v_group_escrow JSONB;
  v_order_json JSONB;
  v_order_id UUID;
  v_order_total NUMERIC;
  v_total_amount NUMERIC := 0;
  v_pickup_pin TEXT;
  v_delivery_pin TEXT;
  v_order_ids UUID[] := '{}';
  v_order_totals NUMERIC[] := '{}';
  v_gift_card_applied NUMERIC := 0;
  v_gift_card_requested NUMERIC;
  v_redeem_result JSONB;
  v_reservation_ref TEXT;
  v_gift_card_transaction_id UUID;
  v_wallet_amount NUMERIC;
  v_hold_result RECORD;
  v_payment_source TEXT;
  v_escrow_id UUID;
  v_escrow_ids UUID[] := '{}';
  v_escrow_total NUMERIC;
  v_vendor_amount NUMERIC;
  v_rider_amount NUMERIC;
  v_platform_amount NUMERIC;
  v_stock RECORD;
  i INT;
BEGIN
  -- Validate the groups payload.
  IF p_groups IS NULL OR jsonb_typeof(p_groups) != 'array' OR jsonb_array_length(p_groups) = 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'p_groups must be a non-empty JSONB array',
      'error_code', 'INVALID_GROUPS'
    );
  END IF;

  p_rewards_amount := COALESCE(p_rewards_amount, 0);
  IF p_rewards_amount < 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Rewards amount cannot be negative',
      'error_code', 'INVALID_REWARDS'
    );
  END IF;

  -- Pass 1: insert all orders and line items, decrement stock, accumulate total.
  FOR i IN 0..jsonb_array_length(p_groups) - 1 LOOP
    v_group := p_groups->i;
    v_group_order := COALESCE(v_group->'order', '{}'::jsonb);
    v_group_items := COALESCE(v_group->'items', '[]'::jsonb);
    v_group_stock := COALESCE(v_group->'stock_updates', '[]'::jsonb);

    -- Buyer must match the order payload.
    IF (v_group_order->>'buyer_id')::UUID IS DISTINCT FROM p_buyer_id THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', format('Group %s buyer ID mismatch', i + 1),
        'error_code', 'BUYER_MISMATCH'
      );
    END IF;

    IF v_group_order->>'order_number' IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', format('Group %s must provide an order_number', i + 1),
        'error_code', 'INVALID_ORDER_NUMBER'
      );
    END IF;

    v_order_total := COALESCE((v_group_order->>'total_amount')::NUMERIC, 0);
    IF v_order_total <= 0 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', format('Group %s order total must be positive', i + 1),
        'error_code', 'INVALID_TOTAL'
      );
    END IF;

    -- Generate 3-digit handoff PINs.
    v_pickup_pin := floor(100 + random() * 900)::int::text;
    v_delivery_pin := floor(100 + random() * 900)::int::text;

    -- Build the orders row, overriding client-supplied PIN, payment,
    -- gift-card, reward, and timestamp fields.
    v_order_json := v_group_order
      - 'id'
      - 'created_at'
      - 'updated_at'
      - 'pickup_pin'
      - 'delivery_pin'
      - 'gift_card_applied_amount'
      - 'gift_card_transaction_id'
      - 'payment_source'
      - 'rewards_used';

    v_order_json := v_order_json || jsonb_build_object(
      'pickup_pin', v_pickup_pin,
      'delivery_pin', v_delivery_pin,
      'created_at', to_jsonb(NOW()),
      'updated_at', to_jsonb(NOW())
    );

    -- Insert the order.
    INSERT INTO orders
    SELECT * FROM jsonb_populate_record(null::orders, v_order_json)
    RETURNING id, total_amount INTO v_order_id, v_order_total;

    v_order_ids := array_append(v_order_ids, v_order_id);
    v_order_totals := array_append(v_order_totals, v_order_total);
    v_total_amount := v_total_amount + v_order_total;

    -- Insert the order's line items.
    INSERT INTO order_items (
      order_id,
      product_id,
      service_id,
      product_name,
      category,
      quantity,
      unit_price,
      total_price,
      scheduled_date,
      scheduled_time,
      service_notes,
      product_metadata,
      created_at
    )
    SELECT
      v_order_id,
      product_id,
      service_id,
      product_name,
      COALESCE(category, 'General'),
      quantity,
      unit_price,
      total_price,
      scheduled_date,
      scheduled_time,
      service_notes,
      COALESCE(product_metadata, '{}'::jsonb),
      NOW()
    FROM jsonb_populate_recordset(null::order_items, v_group_items);

    -- Decrement product stock for explicitly provided stock updates.
    FOR v_stock IN
      SELECT *
      FROM jsonb_to_recordset(v_group_stock) AS s(product_id UUID, quantity INTEGER)
    LOOP
      IF v_stock.product_id IS NOT NULL THEN
        UPDATE products
        SET
          quantity = quantity - v_stock.quantity,
          updated_at = NOW()
        WHERE id = v_stock.product_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Product % not found for stock update', v_stock.product_id;
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  -- Validate that rewards do not exceed the accumulated total.
  IF p_rewards_amount > v_total_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Rewards amount exceeds order group total',
      'error_code', 'INVALID_REWARDS'
    );
  END IF;

  -- Gift card: validate requested amount and clamp to the post-rewards total.
  IF p_gift_card IS NOT NULL THEN
    IF p_gift_card->>'card_number' IS NULL OR p_gift_card->>'pin' IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Gift card number and PIN are required',
        'error_code', 'INVALID_GIFT_CARD'
      );
    END IF;

    v_gift_card_requested := COALESCE((p_gift_card->>'requested_amount')::NUMERIC, v_total_amount - p_rewards_amount);
    v_gift_card_requested := GREATEST(0, LEAST(v_gift_card_requested, v_total_amount - p_rewards_amount));
    v_gift_card_applied := v_gift_card_requested;

    IF v_gift_card_applied > 0 THEN
      v_reservation_ref := gen_random_uuid()::TEXT;

      SELECT * INTO v_redeem_result
      FROM redeem_gift_card_atomic(
        p_gift_card->>'card_number',
        p_gift_card->>'pin',
        p_buyer_id,
        p_admin_gift_user_id,
        v_gift_card_applied,
        v_order_ids[1],
        p_user_ip,
        v_reservation_ref
      );

      IF (v_redeem_result->>'success')::boolean = false THEN
        RAISE EXCEPTION 'Gift card redemption failed: %', v_redeem_result->>'error';
      END IF;

      v_gift_card_applied := COALESCE((v_redeem_result->>'applied_amount')::NUMERIC, v_gift_card_applied);

      SELECT id INTO v_gift_card_transaction_id
      FROM gift_card_transactions
      WHERE gift_card_id = (v_redeem_result->>'gift_card_id')::UUID
        AND metadata @> jsonb_build_object('reservation_ref', v_reservation_ref)
      LIMIT 1;
    END IF;
  END IF;

  -- Recompute wallet amount using the actual applied gift card amount.
  v_wallet_amount := GREATEST(0, v_total_amount - v_gift_card_applied - p_rewards_amount);

  v_payment_source := CASE
    WHEN v_gift_card_applied > 0 AND v_wallet_amount > 0 THEN 'mixed'
    WHEN v_gift_card_applied > 0 THEN 'gift_card'
    WHEN p_rewards_amount > 0 AND v_wallet_amount = 0 THEN 'rewards'
    WHEN p_rewards_amount > 0 AND v_wallet_amount > 0 THEN 'mixed'
    ELSE 'wallet'
  END;

  -- Hold wallet funds once for the accumulated total.
  IF v_wallet_amount > 0 THEN
    SELECT * INTO v_hold_result
    FROM process_wallet_transaction(
      p_buyer_id,
      'purchase_hold',
      v_wallet_amount,
      format('Payment for order group starting %s', v_order_ids[1]),
      v_order_ids[1]::TEXT,
      'order'
    );

    IF NOT v_hold_result.success THEN
      RAISE EXCEPTION 'Wallet hold failed: %', v_hold_result.error_message;
    END IF;
  END IF;

  -- Update each created order with the overall payment/reward/gift values.
  IF array_length(v_order_ids, 1) > 0 THEN
    FOR i IN 1..array_length(v_order_ids, 1) LOOP
      v_order_total := v_order_totals[i];
      UPDATE orders
      SET
        payment_source = v_payment_source,
        gift_card_applied_amount = CASE
          WHEN v_total_amount > 0 THEN ROUND(v_gift_card_applied * v_order_total / v_total_amount, 6)
          ELSE 0
        END,
        rewards_used = CASE
          WHEN v_total_amount > 0 THEN ROUND(p_rewards_amount * v_order_total / v_total_amount, 6)
          ELSE 0
        END,
        gift_card_transaction_id = v_gift_card_transaction_id,
        updated_at = NOW()
      WHERE id = v_order_ids[i];
    END LOOP;
  END IF;

  -- Insert one escrow record per group.
  FOR i IN 0..jsonb_array_length(p_groups) - 1 LOOP
    v_group := p_groups->i;
    v_group_escrow := COALESCE(v_group->'escrow', '{}'::jsonb);

    v_escrow_total := COALESCE((v_group_escrow->>'total_amount')::NUMERIC, v_order_totals[i + 1]);
    v_vendor_amount := COALESCE((v_group_escrow->>'vendor_amount')::NUMERIC, 0);
    v_rider_amount := COALESCE((v_group_escrow->>'rider_amount')::NUMERIC, 0);
    v_platform_amount := COALESCE((v_group_escrow->>'platform_amount')::NUMERIC, 0);

    IF ABS((v_vendor_amount + v_rider_amount + v_platform_amount) - v_escrow_total) > 0.000001 THEN
      RAISE EXCEPTION 'Escrow breakdown does not sum to total: % + % + % != %',
        v_vendor_amount, v_rider_amount, v_platform_amount, v_escrow_total;
    END IF;

    INSERT INTO escrows (
      order_id,
      total_amount,
      vendor_amount,
      rider_amount,
      platform_amount,
      payment_source,
      gift_card_amount,
      status,
      created_at,
      updated_at
    ) VALUES (
      v_order_ids[i + 1],
      v_escrow_total,
      v_vendor_amount,
      v_rider_amount,
      v_platform_amount,
      v_payment_source,
      v_gift_card_applied,
      'held',
      NOW(),
      NOW()
    )
    RETURNING id INTO v_escrow_id;

    v_escrow_ids := array_append(v_escrow_ids, v_escrow_id);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'orders', to_jsonb(v_order_ids),
    'escrows', to_jsonb(v_escrow_ids),
    'payment_source', v_payment_source,
    'gift_card_applied_amount', v_gift_card_applied
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'create_grouped_order_atomic error: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Grouped order creation failed: ' || SQLERRM,
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION create_grouped_order_atomic IS
'Atomically creates a multi-vendor grouped checkout, including order rows, line items, stock decrement, gift card redemption, a single wallet hold, and per-order escrow records in one Postgres transaction.';

REVOKE ALL ON FUNCTION create_grouped_order_atomic(UUID, JSONB, JSONB, NUMERIC, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_grouped_order_atomic(UUID, JSONB, JSONB, NUMERIC, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION create_grouped_order_atomic(UUID, JSONB, JSONB, NUMERIC, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION create_grouped_order_atomic(UUID, JSONB, JSONB, NUMERIC, UUID, TEXT) TO service_role;
ALTER FUNCTION create_grouped_order_atomic(UUID, JSONB, JSONB, NUMERIC, UUID, TEXT) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'create_grouped_order_atomic(uuid,jsonb,jsonb,numeric,uuid,text)', 'EXECUTE') as can_call,
--        has_function_privilege('authenticated', 'create_grouped_order_atomic(uuid,jsonb,jsonb,numeric,uuid,text)', 'EXECUTE') as auth_can_call;
--
-- Expected: can_call = true, auth_can_call = false.
--
-- Next step: replace the multi-call sequence in
-- checkout.service.ts::createGroupedOrder with a single call to this RPC.
-- =====================================================
