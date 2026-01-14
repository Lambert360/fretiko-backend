-- =====================================================
-- CREATE UPDATE_LIVE_STREAM_STOCK_ATOMIC FUNCTION
-- Atomic stock update with row-level locking to prevent race conditions
-- Industry standard: SELECT FOR UPDATE + conditional UPDATE
-- =====================================================

-- Drop function if exists (for clean redeployment)
DROP FUNCTION IF EXISTS update_live_stream_stock_atomic(
  p_live_product_id UUID,
  p_quantity INTEGER
);

-- Create the atomic stock update function
-- This function atomically checks and updates stock in a single transaction
-- Uses SELECT FOR UPDATE to lock the row and prevent concurrent modifications
CREATE OR REPLACE FUNCTION update_live_stream_stock_atomic(
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
  v_sufficient_stock BOOLEAN;
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

  -- 2. Check if sufficient stock is available
  IF v_live_product.live_stock < p_quantity THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', format('Insufficient stock. Only %s items available', v_live_product.live_stock),
      'error_code', 'INSUFFICIENT_STOCK',
      'available_stock', v_live_product.live_stock,
      'requested_quantity', p_quantity
    );
  END IF;

  -- 3. Calculate new stock values
  v_new_stock := v_live_product.live_stock - p_quantity;
  v_new_sold_count := v_live_product.sold_count + p_quantity;

  -- Validate new values don't violate constraints
  IF v_new_stock < 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Stock cannot be negative',
      'error_code', 'NEGATIVE_STOCK'
    );
  END IF;

  -- 4. Update stock atomically (within same transaction)
  -- The row is still locked from SELECT FOR UPDATE above
  UPDATE live_stream_products
  SET 
    live_stock = v_new_stock,
    sold_count = v_new_sold_count,
    updated_at = NOW()
  WHERE id = p_live_product_id
    AND live_stock >= p_quantity; -- Double-check (defense in depth)
  
  -- Check if update succeeded
  IF NOT FOUND THEN
    -- This shouldn't happen if we checked above, but handle it anyway
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Stock was modified during transaction. Please retry.',
      'error_code', 'STOCK_CHANGED'
    );
  END IF;

  -- 5. Return success with updated values
  RETURN jsonb_build_object(
    'success', true,
    'live_product_id', v_live_product.id,
    'old_stock', v_old_stock,
    'new_stock', v_new_stock,
    'old_sold_count', v_old_sold_count,
    'new_sold_count', v_new_sold_count,
    'quantity_deducted', p_quantity
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
COMMENT ON FUNCTION update_live_stream_stock_atomic(UUID, INTEGER) IS 
'Atomically updates live stream product stock using row-level locking to prevent race conditions. Returns JSONB with success status and updated stock values.';

-- Grant execute permission to authenticated users (via service role)
-- The function uses SECURITY DEFINER, so it runs with elevated privileges

