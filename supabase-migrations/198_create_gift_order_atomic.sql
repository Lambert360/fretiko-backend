-- =====================================================
-- Migration: 198
-- Add create_gift_order_atomic(): a single RPC that
-- atomically creates a product order and a gift_orders
-- record in one Postgres transaction.
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION create_gift_order_atomic(
  p_buyer_id UUID,
  p_order JSONB,
  p_items JSONB,
  p_escrow JSONB,
  p_gift_order JSONB,
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
  v_result JSONB;
  v_order_id UUID;
  v_gift_order_id UUID;
BEGIN
  v_result := create_product_order_atomic(
    p_buyer_id,
    p_order,
    p_items,
    p_escrow,
    p_gift_card,
    p_rewards_amount,
    p_admin_gift_user_id,
    p_user_ip
  );

  IF (v_result->>'success')::boolean = false THEN
    RETURN v_result;
  END IF;

  v_order_id := (v_result->'order'->>'id')::UUID;

  INSERT INTO gift_orders (
    order_id,
    gift_giver_id,
    gift_recipient_id,
    wishlist_item_id,
    gift_message,
    is_surprise,
    status,
    created_at,
    updated_at
  ) VALUES (
    v_order_id,
    (p_gift_order->>'gift_giver_id')::UUID,
    (p_gift_order->>'gift_recipient_id')::UUID,
    (p_gift_order->>'wishlist_item_id')::UUID,
    p_gift_order->>'gift_message',
    COALESCE((p_gift_order->>'is_surprise')::boolean, false),
    COALESCE(p_gift_order->>'status', 'pending'),
    NOW(),
    NOW()
  )
  RETURNING id INTO v_gift_order_id;

  RETURN v_result || jsonb_build_object(
    'gift_order',
    jsonb_build_object('id', v_gift_order_id)
  );
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'create_gift_order_atomic error: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Gift order creation failed: ' || SQLERRM,
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION create_gift_order_atomic IS
'Atomically creates a product order, its line items, and a gift_orders record in one Postgres transaction.';

REVOKE ALL ON FUNCTION create_gift_order_atomic(UUID, JSONB, JSONB, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_gift_order_atomic(UUID, JSONB, JSONB, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION create_gift_order_atomic(UUID, JSONB, JSONB, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION create_gift_order_atomic(UUID, JSONB, JSONB, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT) TO service_role;
ALTER FUNCTION create_gift_order_atomic(UUID, JSONB, JSONB, JSONB, JSONB, JSONB, NUMERIC, UUID, TEXT) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'create_gift_order_atomic(uuid,jsonb,jsonb,jsonb,jsonb,jsonb,numeric,uuid,text)', 'EXECUTE') as can_call,
--        has_function_privilege('authenticated', 'create_gift_order_atomic(uuid,jsonb,jsonb,jsonb,jsonb,jsonb,numeric,uuid,text)', 'EXECUTE') as auth_can_call;
--
-- Expected: can_call = true, auth_can_call = false.
-- =====================================================
