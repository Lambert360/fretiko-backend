-- =====================================================
-- ADD WORKSPACE PERFORMANCE INDEXES
-- Optimizes workspace queries for vendor/rider dashboard
-- =====================================================

-- Index for vendor's active orders query
CREATE INDEX IF NOT EXISTS idx_orders_vendor_status_created
ON public.orders(vendor_id, status, created_at DESC)
WHERE vendor_id IS NOT NULL;

-- Index for rider's active orders query
CREATE INDEX IF NOT EXISTS idx_orders_rider_status_created
ON public.orders(rider_id, status, created_at DESC)
WHERE rider_id IS NOT NULL;

-- Index for today's orders query with source
CREATE INDEX IF NOT EXISTS idx_orders_vendor_created_source
ON public.orders(vendor_id, created_at DESC, source)
WHERE vendor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_rider_created_source
ON public.orders(rider_id, created_at DESC, source)
WHERE rider_id IS NOT NULL;

-- Index for escrow queries (escrows table only has order_id, not vendor_id/rider_id)
-- Optimizes: SELECT * FROM escrows WHERE order_id IN (...) AND status = 'held'
CREATE INDEX IF NOT EXISTS idx_escrows_order_status
ON public.escrows(order_id, status);

-- Index for escrow auto-release queries
-- Optimizes: SELECT * FROM escrows WHERE status = 'held' AND auto_release_at < NOW()
CREATE INDEX IF NOT EXISTS idx_escrows_auto_release
ON public.escrows(status, auto_release_at)
WHERE status = 'held' AND auto_release_at IS NOT NULL;

-- Composite index for workspace stats queries
CREATE INDEX IF NOT EXISTS idx_orders_composite_vendor
ON public.orders(vendor_id, created_at DESC, status, source, total_amount);

CREATE INDEX IF NOT EXISTS idx_orders_composite_rider
ON public.orders(rider_id, created_at DESC, status, source, delivery_fee);

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON INDEX idx_orders_vendor_status_created IS 'Optimizes vendor active orders query';
COMMENT ON INDEX idx_orders_rider_status_created IS 'Optimizes rider active orders query';
COMMENT ON INDEX idx_orders_vendor_created_source IS 'Optimizes vendor today orders query with source filtering';
COMMENT ON INDEX idx_orders_rider_created_source IS 'Optimizes rider today orders query with source filtering';
COMMENT ON INDEX idx_escrows_order_status IS 'Optimizes escrow queries by order_id and status';
COMMENT ON INDEX idx_escrows_auto_release IS 'Optimizes auto-release escrow queries';
COMMENT ON INDEX idx_orders_composite_vendor IS 'Composite index for vendor workspace stats';
COMMENT ON INDEX idx_orders_composite_rider IS 'Composite index for rider workspace stats';

-- =====================================================
-- VERIFICATION
-- =====================================================

-- Check created indexes
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename IN ('orders', 'escrows')
AND indexname LIKE 'idx_%workspace%' OR indexname LIKE 'idx_orders_%' OR indexname LIKE 'idx_escrows_%'
ORDER BY tablename, indexname;

