-- =====================================================
-- CREATE ORPHANED ORDERS RPC FUNCTION
-- Fixes the cleanupOrphanedOrders function by properly identifying
-- orders without escrow records using LEFT JOIN
-- =====================================================

CREATE OR REPLACE FUNCTION get_orphaned_orders(
  source_filter TEXT[],
  orphan_threshold TIMESTAMPTZ
)
RETURNS TABLE (
  id UUID,
  order_number TEXT,
  buyer_id UUID,
  vendor_id UUID,
  total_amount DECIMAL,
  source TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    o.id,
    o.order_number,
    o.buyer_id,
    o.vendor_id,
    o.total_amount,
    o.source,
    o.created_at
  FROM orders o
  LEFT JOIN escrows e ON o.id = e.order_id
  WHERE o.status = 'pending'
    AND o.source = ANY(source_filter)
    AND o.created_at < orphan_threshold
    AND e.id IS NULL; -- No escrow means payment never completed
$$;

-- Grant execute permission to authenticated users (via service role)
GRANT EXECUTE ON FUNCTION get_orphaned_orders(TEXT[], TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION get_orphaned_orders(TEXT[], TIMESTAMPTZ) TO service_role;

-- Add comment for documentation
COMMENT ON FUNCTION get_orphaned_orders(TEXT[], TIMESTAMPTZ) IS
'Returns orders that are pending for cleanup: pending status, from specified sources, older than threshold, and have no escrow records (payment never completed). Used by cleanupOrphanedOrders function.';
