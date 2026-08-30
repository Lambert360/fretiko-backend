-- =====================================================
-- Migration: 199
-- Add create_live_product_order_atomic(): a single RPC that atomically
-- handles a live stream product purchase (stock, order, wallet hold,
-- gift card, escrow, and live_stream_transactions) in one Postgres
-- transaction.
--
-- This continues the ACID refactor and is the live-product purchase
-- counterpart to create_product_order_atomic (197).
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION create_live_product_order_atomic(
  p_buyer_id UUID,
  p_order JSONB,
  p_items JSONB,
  p_escrow JSONB,
  p_live_product_id UUID,
  p_quantity INTEGER,
  p_live_transaction JSONB,
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
  v_order_json JSONB;
  v_pickup_pin TEXT;
  v_delivery_pin TEXT;
  v_order_id UUID;
  v_order_total NUMERIC;
  v_order_number TEXT;
  v_gift_card_requested NUMERIC;
  v_gift_card_applied NUMERIC;
  v_gift_card_transaction_id UUID;
  v_reservation_ref TEXT;
  v_redeem_result JSONB;
  v_wallet_amount NUMERIC;
  v_hold_result RECORD;
  v_payment_source TEXT;
  v_live_product_stock INTEGER;
  v_item RECORD;
  v_escrow_total NUMERIC;
  v_vendor_amount NUMERIC;
  v_rider_amount NUMERIC;
  v_platform_amount NUMERIC;
  v_escrow_id UUID;
  v_transaction_id TEXT;
BEGIN
  -- Buyer must match the order payload.
  IF (p_order->>'buyer_id')::UUID IS DISTINCT FROM p_buyer_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Buyer ID mismatch',
      'error_code', 'BUYER_MISMATCH'
    );
  END IF;

  v_order_total := COALESCE((p_order->>'total_amount')::NUMERIC, 0);
  IF v_order_total <= 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Order total must be positive',
      'error_code', 'INVALID_TOTAL'
    );
  END IF;

  p_rewards_amount := COALESCE(p_rewards_amount, 0);
  IF p_rewards_amount < 0 OR p_rewards_amount > v_order_total THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Invalid rewards amount',
      'error_code', 'INVALID_REWARDS'
    );
  END IF;

  IF p_quantity <= 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Quantity must be positive',
      'error_code', 'INVALID_QUANTITY'
    );
  END IF;

  -- Lock and decrement live stream product stock.
  SELECT live_stock INTO v_live_product_stock
  FROM live_stream_products
  WHERE id = p_live_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Live stream product % not found', p_live_product_id;
  END IF;

  IF v_live_product_stock < p_quantity THEN
    RAISE EXCEPTION 'Insufficient live stock for product %: have %, need %',
      p_live_product_id, v_live_product_stock, p_quantity;
  END IF;

  UPDATE live_stream_products
  SET live_stock = live_stock - p_quantity,
      sold_count = sold_count + p_quantity,
      updated_at = NOW()
  WHERE id = p_live_product_id;

  -- Gift card: validate requested amount and clamp to the post-rewards total.
  v_gift_card_applied := 0;
  IF p_gift_card IS NOT NULL THEN
    IF p_gift_card->>'card_number' IS NULL OR p_gift_card->>'pin' IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Gift card number and PIN are required',
        'error_code', 'INVALID_GIFT_CARD'
      );
    END IF;

    v_gift_card_requested := COALESCE((p_gift_card->>'requested_amount')::NUMERIC, v_order_total - p_rewards_amount);
    v_gift_card_requested := GREATEST(0, LEAST(v_gift_card_requested, v_order_total - p_rewards_amount));
    v_gift_card_applied := v_gift_card_requested;
  END IF;

  v_wallet_amount := GREATEST(0, v_order_total - v_gift_card_applied - p_rewards_amount);

  v_payment_source := CASE
    WHEN v_gift_card_applied > 0 AND v_wallet_amount > 0 THEN 'mixed'
    WHEN v_gift_card_applied > 0 THEN 'gift_card'
    ELSE 'wallet'
  END;

  -- Generate 3-digit handoff PINs.
  v_pickup_pin := floor(100 + random() * 900)::int::text;
  v_delivery_pin := floor(100 + random() * 900)::int::text;

  -- Build the orders row, overriding any client-supplied PIN, payment,
  -- gift-card, reward, and timestamp fields.
  v_order_json := p_order
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
    'payment_source', v_payment_source,
    'gift_card_applied_amount', v_gift_card_applied,
    'rewards_used', p_rewards_amount,
    'created_at', to_jsonb(NOW()),
    'updated_at', to_jsonb(NOW())
  );

  -- Insert the order.
  INSERT INTO orders
  SELECT * FROM jsonb_populate_record(null::orders, v_order_json)
  RETURNING id, order_number INTO v_order_id, v_order_number;

  -- Insert order items.
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
    category,
    quantity,
    unit_price,
    total_price,
    scheduled_date,
    scheduled_time,
    service_notes,
    COALESCE(product_metadata, '{}'::jsonb),
    NOW()
  FROM jsonb_populate_recordset(null::order_items, p_items);

  -- Redeem gift card, now that the order has an ID.
  IF p_gift_card IS NOT NULL AND v_gift_card_applied > 0 THEN
    v_reservation_ref := gen_random_uuid()::TEXT;

    SELECT * INTO v_redeem_result
    FROM redeem_gift_card_atomic(
      p_gift_card->>'card_number',
      p_gift_card->>'pin',
      p_buyer_id,
      p_admin_gift_user_id,
      v_gift_card_applied,
      v_order_id,
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

  -- Recompute wallet amount using the actual applied gift card amount.
  v_wallet_amount := GREATEST(0, v_order_total - v_gift_card_applied - p_rewards_amount);

  -- Hold wallet funds.
  IF v_wallet_amount > 0 THEN
    SELECT * INTO v_hold_result
    FROM process_wallet_transaction(
      p_buyer_id,
      'purchase_hold',
      v_wallet_amount,
      format('Payment for order %s', v_order_id),
      v_order_id::TEXT,
      'order'
    );

    IF NOT v_hold_result.success THEN
      RAISE EXCEPTION 'Wallet hold failed: %', v_hold_result.error_message;
    END IF;
  END IF;

  -- Insert escrow record.
  v_escrow_total := COALESCE((p_escrow->>'total_amount')::NUMERIC, v_order_total);
  v_vendor_amount := COALESCE((p_escrow->>'vendor_amount')::NUMERIC, 0);
  v_rider_amount := COALESCE((p_escrow->>'rider_amount')::NUMERIC, 0);
  v_platform_amount := COALESCE((p_escrow->>'platform_amount')::NUMERIC, 0);

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
    v_order_id,
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

  -- Final order update with the actual gift card transaction ID.
  IF v_gift_card_transaction_id IS NOT NULL THEN
    UPDATE orders
    SET
      gift_card_transaction_id = v_gift_card_transaction_id,
      gift_card_applied_amount = v_gift_card_applied,
      payment_source = v_payment_source,
      updated_at = NOW()
    WHERE id = v_order_id;
  END IF;

  -- Insert the live stream transaction record.
  INSERT INTO live_stream_transactions (
    id,
    stream_id,
    buyer_id,
    vendor_id,
    transaction_type,
    product_id,
    quantity,
    unit_price,
    total_amount,
    platform_fee,
    rider_fee,
    status,
    rider_id,
    delivery_address,
    continue_watching,
    order_id,
    created_at,
    updated_at
  ) VALUES (
    p_live_transaction->>'id',
    (p_live_transaction->>'stream_id')::UUID,
    p_buyer_id,
    (p_live_transaction->>'vendor_id')::UUID,
    p_live_transaction->>'transaction_type',
    (p_live_transaction->>'product_id')::UUID,
    (p_live_transaction->>'quantity')::INTEGER,
    (p_live_transaction->>'unit_price')::NUMERIC,
    (p_live_transaction->>'total_amount')::NUMERIC,
    (p_live_transaction->>'platform_fee')::NUMERIC,
    (p_live_transaction->>'rider_fee')::NUMERIC,
    'pending',
    NULLIF(p_live_transaction->>'rider_id', '')::UUID,
    COALESCE((p_live_transaction->'delivery_address')::JSONB, NULL),
    COALESCE((p_live_transaction->>'continue_watching')::BOOLEAN, false),
    v_order_id,
    NOW(),
    NOW()
  )
  RETURNING id INTO v_transaction_id;

  RETURN jsonb_build_object(
    'success', true,
    'order', jsonb_build_object(
      'id', v_order_id,
      'order_number', v_order_number,
      'pickup_pin', v_pickup_pin,
      'delivery_pin', v_delivery_pin,
      'payment_source', v_payment_source,
      'gift_card_applied_amount', v_gift_card_applied,
      'gift_card_transaction_id', v_gift_card_transaction_id
    ),
    'escrow', jsonb_build_object(
      'id', v_escrow_id,
      'total_amount', v_escrow_total,
      'vendor_amount', v_vendor_amount,
      'rider_amount', v_rider_amount,
      'platform_amount', v_platform_amount
    ),
    'live_transaction', jsonb_build_object(
      'id', v_transaction_id
    )
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'create_live_product_order_atomic error: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Live product order creation failed: ' || SQLERRM,
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION create_live_product_order_atomic IS
'Atomically creates a live product order, its line items, decrements live stock, redeems a gift card, holds wallet funds, creates an escrow record, and inserts a live_stream_transactions record in one Postgres transaction.';

REVOKE ALL ON FUNCTION create_live_product_order_atomic(UUID, JSONB, JSONB, JSONB, UUID, INTEGER, JSONB, JSONB, NUMERIC, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_live_product_order_atomic(UUID, JSONB, JSONB, JSONB, UUID, INTEGER, JSONB, JSONB, NUMERIC, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION create_live_product_order_atomic(UUID, JSONB, JSONB, JSONB, UUID, INTEGER, JSONB, JSONB, NUMERIC, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION create_live_product_order_atomic(UUID, JSONB, JSONB, JSONB, UUID, INTEGER, JSONB, JSONB, NUMERIC, UUID, TEXT) TO service_role;
ALTER FUNCTION create_live_product_order_atomic(UUID, JSONB, JSONB, JSONB, UUID, INTEGER, JSONB, JSONB, NUMERIC, UUID, TEXT) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'create_live_product_order_atomic(uuid,jsonb,jsonb,jsonb,uuid,integer,jsonb,jsonb,numeric,uuid,text)', 'EXECUTE') as can_call,
--        has_function_privilege('authenticated', 'create_live_product_order_atomic(uuid,jsonb,jsonb,jsonb,uuid,integer,jsonb,jsonb,numeric,uuid,text)', 'EXECUTE') as auth_can_call;
--
-- Expected: can_call = true, auth_can_call = false.
-- =====================================================
