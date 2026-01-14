-- =====================================================
-- CREATE RESTORE_LIVE_STREAM_STOCK_ATOMIC FUNCTION
-- Atomic stock restoration with row-level locking
-- Used when order creation fails or duplicate purchase detected
-- =====================================================

-- Drop function if exists (for clean redeployment)
DROP FUNCTION IF EXISTS restore_live_stream_stock_atomic(
  p_live_product_id UUID,
  p_quantity INTEGER
);

-- Create the atomic stock restoration function
-- This function atomically restores stock in a single transaction
-- Uses SELECT FOR UPDATE to lock the row and prevent concurrent modifications
CREATE OR REPLACE FUNCTION restore_live_stream_stock_atomic(
  p_live_product_id UUID,
  p_quantity INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_live_product RECORD;
  v_old_stock INTEGER;
  v_old_sold_count INTEGER;
  v_new_stock INTEGER;
  v_new_sold_count INTEGER;
BEGIN
  -- 1. Lock and fetch live product atomically with SELECT FOR UPDATE
  -- This prevents race conditions by locking the row until transaction completes
  SELECT 
    id,
    stream_id,
    product_id,
    live_stock,
    sold_count,
    original_stock
  INTO v_live_product
  FROM live_stream_products
  WHERE id = p_live_product_id
  FOR UPDATE; -- Lock row to prevent concurrent modifications
  
  -- Check if product found
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Live stream product not found',
      'error_code', 'PRODUCT_NOT_FOUND'
    );
  END IF;

  -- Store old values for response
  v_old_stock := v_live_product.live_stock;
  v_old_sold_count := v_live_product.sold_count;

  -- 2. Calculate new stock values (restore quantity, reduce sold count)
  v_new_stock := v_live_product.live_stock + p_quantity;
  v_new_sold_count := GREATEST(0, v_live_product.sold_count - p_quantity); -- Ensure non-negative

  -- Validate new values don't exceed original stock
  IF v_new_stock > v_live_product.original_stock THEN
    -- Cap at original stock if somehow exceeded
    v_new_stock := v_live_product.original_stock;
  END IF;

  -- 3. Update stock atomically (within same transaction)
  -- The row is still locked from SELECT FOR UPDATE above
  UPDATE live_stream_products
  SET 
    live_stock = v_new_stock,
    sold_count = v_new_sold_count,
    updated_at = NOW()
  WHERE id = p_live_product_id;
  
  -- Check if update succeeded
  IF NOT FOUND THEN
    -- This shouldn't happen if we checked above, but handle it anyway
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Product was deleted during transaction',
      'error_code', 'PRODUCT_DELETED'
    );
  END IF;

  -- 4. Return success with updated values
  RETURN jsonb_build_object(
    'success', true,
    'live_product_id', v_live_product.id,
    'old_stock', v_old_stock,
    'new_stock', v_new_stock,
    'old_sold_count', v_old_sold_count,
    'new_sold_count', v_new_sold_count,
    'quantity_restored', p_quantity
  );

EXCEPTION
  WHEN OTHERS THEN
    -- Catch any unexpected errors and return error response
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM,
      'error_code', 'UNEXPECTED_ERROR'
    );
END;
$$;

-- Add comment to function
COMMENT ON FUNCTION restore_live_stream_stock_atomic(UUID, INTEGER) IS 
'Atomically restores live stream product stock using row-level locking. Used when order creation fails or duplicate purchase is detected. Returns JSONB with success status and updated stock values.';

