-- =====================================================
-- CREATE LIVE STREAM STOCK RESERVATIONS TABLE
-- Database-backed stock reservations with expiration
-- Industry standard: Temporary holds with automatic cleanup
-- =====================================================

-- Create stock reservations table
CREATE TABLE IF NOT EXISTS live_stream_stock_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    live_product_id UUID NOT NULL REFERENCES live_stream_products(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'cancelled', 'expired')),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    confirmed_at TIMESTAMP WITH TIME ZONE,
    cancelled_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_reservations_stream_product ON live_stream_stock_reservations(stream_id, product_id);
CREATE INDEX IF NOT EXISTS idx_reservations_user ON live_stream_stock_reservations(user_id);
CREATE INDEX IF NOT EXISTS idx_reservations_expires_at ON live_stream_stock_reservations(expires_at);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON live_stream_stock_reservations(status);
CREATE INDEX IF NOT EXISTS idx_reservations_live_product ON live_stream_stock_reservations(live_product_id);

-- Create unique constraint to prevent duplicate active reservations for same user/product
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_unique_active 
ON live_stream_stock_reservations(stream_id, product_id, user_id) 
WHERE status = 'active';

-- Add comment to table
COMMENT ON TABLE live_stream_stock_reservations IS 
'Stores temporary stock reservations for live stream products. Reservations expire after 5 minutes and are automatically cleaned up.';

-- =====================================================
-- CREATE CLEANUP FUNCTION FOR EXPIRED RESERVATIONS
-- Automatically cancels expired reservations and releases stock
-- =====================================================

CREATE OR REPLACE FUNCTION cleanup_expired_stock_reservations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_expired_count INTEGER := 0;
  v_reservation RECORD;
BEGIN
  -- Find all expired active reservations
  FOR v_reservation IN
    SELECT 
      r.id,
      r.live_product_id,
      r.quantity,
      r.stream_id,
      r.product_id
    FROM live_stream_stock_reservations r
    WHERE r.status = 'active'
      AND r.expires_at < NOW()
    FOR UPDATE -- Lock rows to prevent concurrent modifications
  LOOP
    -- Mark reservation as expired
    UPDATE live_stream_stock_reservations
    SET 
      status = 'expired',
      cancelled_at = NOW(),
      updated_at = NOW()
    WHERE id = v_reservation.id;

    -- Note: Stock is not released here because it was never actually deducted
    -- The reservation just prevents other users from purchasing the reserved quantity
    -- When reservation expires, the stock becomes available again automatically

    v_expired_count := v_expired_count + 1;
  END LOOP;

  RETURN v_expired_count;
END;
$$;

-- Add comment to function
COMMENT ON FUNCTION cleanup_expired_stock_reservations() IS 
'Cleans up expired stock reservations. Should be called periodically (e.g., every minute) via cron job.';

-- =====================================================
-- CREATE FUNCTION TO GET AVAILABLE STOCK (considering reservations)
-- =====================================================

CREATE OR REPLACE FUNCTION get_available_live_stock(
  p_live_product_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_stock INTEGER;
  v_reserved_stock INTEGER;
  v_available_stock INTEGER;
BEGIN
  -- Get current stock
  SELECT live_stock INTO v_current_stock
  FROM live_stream_products
  WHERE id = p_live_product_id;

  IF v_current_stock IS NULL THEN
    RETURN 0;
  END IF;

  -- Get total reserved stock (active reservations only)
  SELECT COALESCE(SUM(quantity), 0) INTO v_reserved_stock
  FROM live_stream_stock_reservations
  WHERE live_product_id = p_live_product_id
    AND status = 'active'
    AND expires_at > NOW(); -- Only count non-expired reservations

  -- Calculate available stock
  v_available_stock := v_current_stock - v_reserved_stock;

  -- Ensure non-negative
  IF v_available_stock < 0 THEN
    v_available_stock := 0;
  END IF;

  RETURN v_available_stock;
END;
$$;

-- Add comment to function
COMMENT ON FUNCTION get_available_live_stock(UUID) IS 
'Returns available stock for a live product, accounting for active reservations.';

