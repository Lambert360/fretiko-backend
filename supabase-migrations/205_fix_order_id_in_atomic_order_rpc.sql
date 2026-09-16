-- =====================================================
-- Migration: 205
-- Fix: generate orders.id explicitly inside all atomic order-creation RPCs.
--        - 197 create_product_order_atomic
--        - 199 create_live_product_order_atomic
--        - 200 create_live_service_booking_atomic
--        - 201 create_grouped_order_atomic
-- This replaces the temporary guard added by migration 204 and removes it.
-- =====================================================

BEGIN;

-- =====================================================
-- Migration: 197
-- Add create_product_order_atomic(): a single RPC that atomically
-- creates an orders row, its order_items, decrements product stock,
-- redeems a gift card, holds the buyer's wallet funds, and inserts
-- an escrows record in one Postgres transaction.
--
-- Background (the bug this fixes):
--   checkout.service.ts::createOrder currently performs these steps
--   as separate network calls:
--     1. orders insert
--     2. order_items insert
--     3. rewards redemption (non-DB RPC)
--     4. wallet hold (complete_purchase_hold_atomic)
--     5. escrow insert (escrowService.createEscrow)
--     6. product stock update (after the hold)
--   Any failure after step 4 leaves money held without a matching
--   escrow, or an order without stock. This migration folds the
--   entire money/order lifecycle into one DB transaction.
--
-- What this migration does:
--   Adds create_product_order_atomic() which, in one transaction:
--     1. Validates the order payload and computes payment source.
--     2. Decrements products.quantity for each product line item.
--     3. Inserts the orders row and order_items rows.
--     4. Redeems the gift card (if supplied) using
--        redeem_gift_card_atomic and p_order_id = the new order.
--     5. Holds the wallet portion via process_wallet_transaction.
--     6. Inserts the escrows row with the provided breakdown.
--     7. Updates the orders row with gift card / payment details.
--   If any step fails, the entire transaction rolls back.
--
--   This is additive-only and does not modify existing functions.
-- =====================================================


CREATE OR REPLACE FUNCTION create_product_order_atomic(
  p_buyer_id UUID,
  p_order JSONB,
  p_items JSONB,
  p_escrow JSONB,
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
  v_gift_card_requested NUMERIC;
  v_gift_card_applied NUMERIC;
  v_gift_card_transaction_id UUID;
  v_reservation_ref TEXT;
  v_redeem_result JSONB;
  v_wallet_amount NUMERIC;
  v_hold_result RECORD;
  v_payment_source TEXT;
  v_product_record RECORD;
  v_item RECORD;
  v_escrow_total NUMERIC;
  v_vendor_amount NUMERIC;
  v_rider_amount NUMERIC;
  v_platform_amount NUMERIC;
  v_escrow_id UUID;
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
  -- Generate order id explicitly so jsonb_populate_record does not insert NULL.
  v_order_id := gen_random_uuid();

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
    'id', v_order_id,
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
  RETURNING id INTO v_order_id;

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

  -- Decrement product stock before any money moves.
  FOR v_item IN SELECT * FROM jsonb_populate_recordset(null::order_items, p_items) LOOP
    IF v_item.product_id IS NOT NULL THEN
      SELECT quantity INTO v_product_record
      FROM products
      WHERE id = v_item.product_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Product % not found', v_item.product_id;
      END IF;

      IF v_product_record.quantity IS NOT NULL THEN
        IF v_product_record.quantity < v_item.quantity THEN
          RAISE EXCEPTION 'Insufficient stock for product %: have %, need %', v_item.product_id, v_product_record.quantity, v_item.quantity;
        END IF;

        UPDATE products
        SET quantity = quantity - v_item.quantity,
            updated_at = NOW()
        WHERE id = v_item.product_id;
      END IF;
    END IF;
  END LOOP;

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
    RAISE EXCEPTION 'Escrow breakdown does not sum to total: % + % + % != %', v_vendor_amount, v_rider_amount, v_platform_amount, v_escrow_total;
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

  RETURN jsonb_build_object(
    'success', true,
    'order', jsonb_build_object(
      'id', v_order_id,
      'order_number', (p_order->>'order_number'),
      'pickup_pin', v_pickup_pin,
      'delivery_pin', v_delivery_pin,
      'payment_source', v_payment_source,
      'gift_card_applied_amount', v_gift_card_applied,
      'gift_card_transaction_id', v_gift_card_transaction_id
    ),
    'escrow', jsonb_build_object(
      'id', v_escrow_id,
      'total_amount', v_escrow_total
    )
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'create_product_order_atomic error: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Order creation failed: ' || SQLERRM,
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION create_product_order_atomic IS
'Atomically creates a product order, its line items, decrements stock, redeems a gift card, holds wallet funds, and creates an escrow record in one Postgres transaction.';

REVOKE ALL ON FUNCTION create_product_order_atomic(UUID, JSONB, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_product_order_atomic(UUID, JSONB, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION create_product_order_atomic(UUID, JSONB, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION create_product_order_atomic(UUID, JSONB, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT) TO service_role;
ALTER FUNCTION create_product_order_atomic(UUID, JSONB, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT) SET search_path = public, pg_temp;


-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'create_product_order_atomic(uuid,jsonb,jsonb,jsonb,jsonb,numeric,uuid,text)', 'EXECUTE') as can_call,
--        has_function_privilege('authenticated', 'create_product_order_atomic(uuid,jsonb,jsonb,jsonb,jsonb,numeric,uuid,text)', 'EXECUTE') as auth_can_call;
--
-- Expected: can_call = true, auth_can_call = false.
--
-- Next step: replace the multi-call sequence in
-- checkout.service.ts::createOrder with a single call to this RPC.
-- =====================================================

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
  -- Generate order id explicitly so jsonb_populate_record does not insert NULL.
  v_order_id := gen_random_uuid();

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
    'id', v_order_id,
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


-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'create_live_product_order_atomic(uuid,jsonb,jsonb,jsonb,uuid,integer,jsonb,jsonb,numeric,uuid,text)', 'EXECUTE') as can_call,
--        has_function_privilege('authenticated', 'create_live_product_order_atomic(uuid,jsonb,jsonb,jsonb,uuid,integer,jsonb,jsonb,numeric,uuid,text)', 'EXECUTE') as auth_can_call;
--
-- Expected: can_call = true, auth_can_call = false.
-- =====================================================

-- =====================================================
-- Migration: 200
-- Add create_live_service_booking_atomic(): a single RPC that atomically
-- books a live service slot, creates an orders row and service order_item,
-- redeems a gift card, holds wallet funds, creates an escrow, and inserts
-- a live_stream_transactions record in one Postgres transaction.
--
-- Background (the bug this fixes):
--   live-sales.service.ts::bookService currently performs these steps
--   as separate network calls:
--     1. orders insert
--     2. order_items insert
--     3. gift card apply
--     4. wallet hold (complete_purchase_hold_atomic)
--     5. service slot booking (book_live_service_slot_atomic)
--     6. escrow insert (escrowService.createEscrow)
--     7. live_stream_transactions insert
--   Any failure after step 4 can hold money without a slot or transaction.
--   This migration folds the entire booking lifecycle into one DB transaction.
-- =====================================================


CREATE OR REPLACE FUNCTION create_live_service_booking_atomic(
  p_buyer_id UUID,
  p_order JSONB,
  p_items JSONB,
  p_escrow JSONB,
  p_live_service_id UUID,
  p_slot JSONB,
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
  v_gift_card_requested NUMERIC;
  v_gift_card_applied NUMERIC;
  v_gift_card_transaction_id UUID;
  v_reservation_ref TEXT;
  v_redeem_result JSONB;
  v_wallet_amount NUMERIC;
  v_hold_result RECORD;
  v_payment_source TEXT;
  v_escrow_total NUMERIC;
  v_vendor_amount NUMERIC;
  v_rider_amount NUMERIC;
  v_platform_amount NUMERIC;
  v_escrow_id UUID;
  v_slot_result JSONB;
  v_live_transaction_id UUID;
  v_live_transaction_json JSONB;
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

  -- Generate 3-digit handoff PINs (services generally do not use them, but keep
  -- consistent with other order types).
  v_pickup_pin := floor(100 + random() * 900)::int::text;
  v_delivery_pin := floor(100 + random() * 900)::int::text;
  -- Generate order id explicitly so jsonb_populate_record does not insert NULL.
  v_order_id := gen_random_uuid();

  -- Book the live service slot atomically first.
  v_slot_result := book_live_service_slot_atomic(
    p_live_service_id,
    (p_slot->>'date')::DATE,
    (p_slot->>'time')::TIME
  );

  IF (v_slot_result->>'success')::boolean = false THEN
    RETURN v_slot_result;
  END IF;

  -- Build the orders row, overriding client-supplied generated fields.
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
    'id', v_order_id,
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
  RETURNING id INTO v_order_id;

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
      format('Payment for service booking %s', v_order_id),
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
    RAISE EXCEPTION 'Escrow breakdown does not sum to total: % + % + % != %', v_vendor_amount, v_rider_amount, v_platform_amount, v_escrow_total;
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

  -- Insert the live_stream_transactions record.
  v_live_transaction_json := p_live_transaction
    - 'id'
    - 'created_at'
    - 'updated_at'
    - 'order_id'
    - 'status';

  v_live_transaction_json := v_live_transaction_json || jsonb_build_object(
    'order_id', v_order_id,
    'status', 'pending',
    'created_at', to_jsonb(NOW()),
    'updated_at', to_jsonb(NOW())
  );

  INSERT INTO live_stream_transactions
  SELECT * FROM jsonb_populate_record(null::live_stream_transactions, v_live_transaction_json)
  RETURNING id INTO v_live_transaction_id;

  RETURN jsonb_build_object(
    'success', true,
    'order', jsonb_build_object(
      'id', v_order_id,
      'order_number', (p_order->>'order_number'),
      'pickup_pin', v_pickup_pin,
      'delivery_pin', v_delivery_pin,
      'payment_source', v_payment_source,
      'gift_card_applied_amount', v_gift_card_applied,
      'gift_card_transaction_id', v_gift_card_transaction_id
    ),
    'escrow', jsonb_build_object(
      'id', v_escrow_id,
      'total_amount', v_escrow_total
    ),
    'live_transaction', jsonb_build_object(
      'id', v_live_transaction_id
    )
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'create_live_service_booking_atomic error: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Service booking creation failed: ' || SQLERRM,
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION create_live_service_booking_atomic IS
'Atomically books a live service slot, creates the service order, holds wallet funds, creates an escrow, and inserts a live stream transaction in one Postgres transaction.';

REVOKE ALL ON FUNCTION create_live_service_booking_atomic(UUID, JSONB, JSONB, JSONB, UUID, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_live_service_booking_atomic(UUID, JSONB, JSONB, JSONB, UUID, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION create_live_service_booking_atomic(UUID, JSONB, JSONB, JSONB, UUID, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION create_live_service_booking_atomic(UUID, JSONB, JSONB, JSONB, UUID, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT) TO service_role;
ALTER FUNCTION create_live_service_booking_atomic(UUID, JSONB, JSONB, JSONB, UUID, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT) SET search_path = public, pg_temp;


-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'create_live_service_booking_atomic(uuid,jsonb,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,numeric,uuid,text)', 'EXECUTE') as can_call,
--        has_function_privilege('authenticated', 'create_live_service_booking_atomic(uuid,jsonb,jsonb,jsonb,uuid,jsonb,jsonb,jsonb,numeric,uuid,text)', 'EXECUTE') as auth_can_call;
--
-- Expected: can_call = true, auth_can_call = false.
--
-- Next step: replace the multi-call sequence in
-- live-sales.service.ts::bookService with a single call to this RPC.
-- =====================================================

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
    -- Generate order id explicitly so jsonb_populate_record does not insert NULL.
    v_order_id := gen_random_uuid();

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
      'id', v_order_id,
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

-- Drop the temporary guard from migration 204; the RPCs now handle id generation.
DROP TRIGGER IF EXISTS ensure_order_id_on_insert ON public.orders;
DROP FUNCTION IF EXISTS public.ensure_order_id_on_insert();

COMMIT;
