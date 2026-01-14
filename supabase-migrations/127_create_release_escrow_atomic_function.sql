-- =====================================================
-- CREATE RELEASE_ESCROW_ATOMIC FUNCTION
-- Atomic escrow release with row-level locking to prevent race conditions
-- =====================================================

-- Drop function if exists (for clean redeployment)
DROP FUNCTION IF EXISTS release_escrow_atomic(
  p_escrow_id UUID,
  p_reason TEXT,
  p_user_id UUID
);

-- Create the atomic escrow release function
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
  v_escrow RECORD;
  v_order RECORD;
  v_authorized BOOLEAN := FALSE;
  v_is_auto_release BOOLEAN := FALSE;
  v_is_buyer_confirmed BOOLEAN := FALSE;
BEGIN
  -- 1. Lock and fetch escrow atomically with SELECT FOR UPDATE
  -- This prevents race conditions by locking the row until transaction completes
  SELECT 
    e.id,
    e.order_id,
    e.total_amount,
    e.vendor_amount,
    e.rider_amount,
    e.platform_amount,
    e.status,
    e.auto_release_at,
    e.released_at,
    e.release_reason,
    e.created_at,
    e.updated_at,
    o.id as order_id_full,
    o.order_number,
    o.buyer_id,
    o.vendor_id,
    o.rider_id,
    o.status as order_status,
    o.delivered_at,
    o.order_confirmed_at
  INTO v_escrow
  FROM escrows e
  INNER JOIN orders o ON e.order_id = o.id
  WHERE e.id = p_escrow_id
    AND e.status = 'held'  -- Only fetch if still held
  FOR UPDATE OF e;  -- Lock escrow row to prevent concurrent modifications
  
  -- Check if escrow found
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Escrow not found or already released',
      'error_code', 'ESCROW_NOT_FOUND'
    );
  END IF;

  -- Build order record for easier access
  v_order.id := v_escrow.order_id_full;
  v_order.order_number := v_escrow.order_number;
  v_order.buyer_id := v_escrow.buyer_id;
  v_order.vendor_id := v_escrow.vendor_id;
  v_order.rider_id := v_escrow.rider_id;
  v_order.status := v_escrow.order_status;
  v_order.delivered_at := v_escrow.delivered_at;
  v_order.order_confirmed_at := v_escrow.order_confirmed_at;

  -- 2. Authorization check (if user_id provided)
  IF p_user_id IS NOT NULL THEN
    IF v_order.vendor_id = p_user_id THEN
      v_authorized := TRUE;
    ELSIF v_order.buyer_id = p_user_id THEN
      v_authorized := TRUE;
    ELSIF v_order.rider_id IS NOT NULL AND v_order.rider_id = p_user_id THEN
      v_authorized := TRUE;
    -- TODO: Add admin check when admin system is implemented
    -- ELSIF is_admin(p_user_id) THEN
    --   v_authorized := TRUE;
    END IF;

    IF NOT v_authorized THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Unauthorized - only vendor, buyer, or rider can release escrow',
        'error_code', 'UNAUTHORIZED'
      );
    END IF;
  ELSE
    -- No user_id provided - assume system/admin call (for auto-release)
    v_authorized := TRUE;
  END IF;

  -- 3. Validate order status
  IF v_order.status = 'cancelled' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Cannot release escrow for cancelled order',
      'error_code', 'ORDER_CANCELLED'
    );
  END IF;

  -- 4. Validate delivery/confirmation status (for manual releases)
  v_is_auto_release := (p_reason LIKE 'Auto-released%');
  v_is_buyer_confirmed := (p_reason LIKE 'Buyer confirmed%' OR p_reason LIKE 'Buyer manually confirmed%');
  
  IF NOT v_is_auto_release AND NOT v_is_buyer_confirmed THEN
    -- Manual release - must verify order is delivered or confirmed
    IF v_order.delivered_at IS NULL AND v_order.order_confirmed_at IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Order must be delivered or confirmed before releasing escrow manually',
        'error_code', 'ORDER_NOT_DELIVERED'
      );
    END IF;
  END IF;

  -- 5. Update escrow status atomically (within same transaction as lock)
  UPDATE escrows
  SET 
    status = 'released',
    released_at = NOW(),
    release_reason = p_reason,
    updated_at = NOW()
  WHERE id = p_escrow_id
    AND status = 'held';  -- Double-check status (defense in depth)
  
  -- Verify the update succeeded
  IF NOT FOUND THEN
    -- This shouldn't happen since we have the lock, but check anyway
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Escrow status changed during processing',
      'error_code', 'STATUS_CHANGED'
    );
  END IF;

  -- 6. Return escrow and order data for wallet processing
  RETURN jsonb_build_object(
    'success', true,
    'escrow', jsonb_build_object(
      'id', v_escrow.id,
      'order_id', v_escrow.order_id,
      'total_amount', v_escrow.total_amount,
      'vendor_amount', v_escrow.vendor_amount,
      'rider_amount', v_escrow.rider_amount,
      'platform_amount', v_escrow.platform_amount,
      'status', 'released'
    ),
    'order', jsonb_build_object(
      'id', v_order.id,
      'order_number', v_order.order_number,
      'buyer_id', v_order.buyer_id,
      'vendor_id', v_order.vendor_id,
      'rider_id', v_order.rider_id,
      'status', v_order.status,
      'delivered_at', v_order.delivered_at,
      'order_confirmed_at', v_order.order_confirmed_at
    )
  );
EXCEPTION
  WHEN OTHERS THEN
    -- Log error and return failure
    RAISE WARNING 'Error in release_escrow_atomic: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during escrow release',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

-- Add comment explaining the function
COMMENT ON FUNCTION release_escrow_atomic IS 
'Atomically releases an escrow with row-level locking to prevent race conditions. 
Uses SELECT FOR UPDATE to lock the escrow row during the entire transaction, 
ensuring only one release can succeed even with concurrent requests.
Returns JSONB with success status and escrow/order data if successful, or error details if failed.';

