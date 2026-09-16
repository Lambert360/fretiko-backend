-- =====================================================
-- Migration: 206
-- Fix two issues in live stream service/portfolio bookings:
--
-- 1. live_stream_transactions was created in
--    migrations/025_create_live_sales.sql WITHOUT an order_id column.
--    create_live_product_order_atomic (199) and
--    create_live_service_booking_atomic (200) both insert order_id into
--    live_stream_transactions, so every live purchase/booking failed with:
--      "column \"order_id\" of relation \"live_stream_transactions\" does not exist"
--
-- 2. Service live streams are meant to let vendors without a listed service
--    go live and showcase work via portfolio. Viewers propose a date/time;
--    the vendor accepts/rejects later. There is no hard slot reservation.
--    This migration adds a p_skip_slot_booking flag to
--    create_live_service_booking_atomic and relaxes the
--    valid_product_transaction check so service_id can be NULL for these
--    unlisted service/portfolio bookings.
-- =====================================================

BEGIN;

-- 1. Add the missing order_id column and indexes.
ALTER TABLE public.live_stream_transactions
ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_live_transactions_order
ON public.live_stream_transactions(order_id);

CREATE INDEX IF NOT EXISTS idx_live_transactions_status
ON public.live_stream_transactions(status);

CREATE INDEX IF NOT EXISTS idx_live_transactions_buyer
ON public.live_stream_transactions(buyer_id, created_at DESC);

COMMENT ON COLUMN public.live_stream_transactions.order_id IS 'References the order record for escrow-protected purchases';

-- 2. Relax the check constraint so service_id can be NULL for service
--    transactions (portfolio or unlisted live service bookings).
ALTER TABLE public.live_stream_transactions
DROP CONSTRAINT IF EXISTS valid_product_transaction;

ALTER TABLE public.live_stream_transactions
ADD CONSTRAINT valid_product_transaction CHECK (
    (transaction_type = 'product' AND product_id IS NOT NULL AND quantity IS NOT NULL AND unit_price IS NOT NULL) OR
    (transaction_type = 'service' AND product_id IS NULL)
);

COMMIT;

-- 3. Recreate create_live_service_booking_atomic with an optional
--    p_skip_slot_booking parameter. This is done outside the main
--    transaction because function signature changes require dropping
--    and recreating.

-- Drop both possible old signatures so the migration is idempotent.
DROP FUNCTION IF EXISTS public.create_live_service_booking_atomic(
  UUID, JSONB, JSONB, JSONB, UUID, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT
);
DROP FUNCTION IF EXISTS public.create_live_service_booking_atomic(
  UUID, JSONB, JSONB, JSONB, UUID, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT, BOOLEAN
);

CREATE OR REPLACE FUNCTION public.create_live_service_booking_atomic(
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
  p_user_ip TEXT DEFAULT NULL,
  p_skip_slot_booking BOOLEAN DEFAULT FALSE
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

  -- Book the live service slot atomically first, unless the caller asked to skip
  -- it. Portfolio and unlisted service bookings let the viewer propose any
  -- future time; the vendor accepts/rejects later, so no slot is reserved here.
  IF p_skip_slot_booking IS NOT TRUE THEN
    v_slot_result := book_live_service_slot_atomic(
      p_live_service_id,
      (p_slot->>'date')::DATE,
      (p_slot->>'time')::TIME
    );

    IF (v_slot_result->>'success')::boolean = false THEN
      RETURN v_slot_result;
    END IF;
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

COMMENT ON FUNCTION public.create_live_service_booking_atomic IS
'Atomically books a live service slot (or skips slot reservation for portfolio/unlisted service bookings), creates the service order, holds wallet funds, creates an escrow, and inserts a live stream transaction in one Postgres transaction.';

REVOKE ALL ON FUNCTION public.create_live_service_booking_atomic(UUID, JSONB, JSONB, JSONB, UUID, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_live_service_booking_atomic(UUID, JSONB, JSONB, JSONB, UUID, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT, BOOLEAN) FROM anon;
REVOKE ALL ON FUNCTION public.create_live_service_booking_atomic(UUID, JSONB, JSONB, JSONB, UUID, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT, BOOLEAN) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_live_service_booking_atomic(UUID, JSONB, JSONB, JSONB, UUID, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT, BOOLEAN) TO service_role;
ALTER FUNCTION public.create_live_service_booking_atomic(UUID, JSONB, JSONB, JSONB, UUID, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT, BOOLEAN) SET search_path = public, pg_temp;

-- =====================================================
-- Verification (run manually after applying):
--
-- select column_name from information_schema.columns
-- where table_name = 'live_stream_transactions' and column_name = 'order_id';
--
-- select proname, pg_get_function_arguments(oid) from pg_proc
-- where proname = 'create_live_service_booking_atomic';
-- Expected: p_buyer_id uuid, p_order jsonb, p_items jsonb, p_escrow jsonb,
--           p_live_service_id uuid, p_slot jsonb, p_live_transaction jsonb,
--           p_gift_card jsonb DEFAULT NULL::jsonb, p_rewards_amount numeric DEFAULT 0,
--           p_admin_gift_user_id uuid DEFAULT NULL::uuid, p_user_ip text DEFAULT NULL::text,
--           p_skip_slot_booking boolean DEFAULT false
-- =====================================================
