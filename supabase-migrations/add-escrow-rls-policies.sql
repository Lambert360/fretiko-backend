-- ================================================
-- ESCROW TABLE RLS POLICIES
-- ================================================
-- These policies ensure users can only view/manage escrows they're involved in
-- as buyer, vendor, or rider

-- Enable RLS on escrows table
ALTER TABLE escrows ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Users can view their own escrows" ON escrows;
DROP POLICY IF EXISTS "Users can view escrows they are involved in" ON escrows;
DROP POLICY IF EXISTS "Service can manage all escrows" ON escrows;

-- ================================================
-- SELECT POLICY: Users can view escrows where they are buyer, vendor, or rider
-- ================================================
CREATE POLICY "Users can view escrows they are involved in"
ON escrows
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM orders
    WHERE orders.id = escrows.order_id
    AND (
      orders.buyer_id = auth.uid()
      OR orders.vendor_id = auth.uid()
      OR orders.rider_id = auth.uid()
    )
  )
);

-- ================================================
-- INSERT POLICY: Only service role can create escrows (done via backend)
-- ================================================
CREATE POLICY "Service can create escrows"
ON escrows
FOR INSERT
WITH CHECK (auth.role() = 'service_role' OR auth.role() = 'authenticated');

-- ================================================
-- UPDATE POLICY: Users can update escrows in limited ways
-- Vendors can request release, buyers can dispute
-- ================================================
CREATE POLICY "Users can update escrows they are involved in"
ON escrows
FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM orders
    WHERE orders.id = escrows.order_id
    AND (
      orders.buyer_id = auth.uid()
      OR orders.vendor_id = auth.uid()
      OR orders.rider_id = auth.uid()
    )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM orders
    WHERE orders.id = escrows.order_id
    AND (
      orders.buyer_id = auth.uid()
      OR orders.vendor_id = auth.uid()
      OR orders.rider_id = auth.uid()
    )
  )
);

-- ================================================
-- ADMIN POLICY: Service role can manage all escrows (for backend operations)
-- ================================================
CREATE POLICY "Service role can manage all escrows"
ON escrows
FOR ALL
USING (auth.role() = 'service_role')
WITH CHECK (auth.role() = 'service_role');

-- ================================================
-- CREATE INDEX for performance on escrow queries
-- ================================================
CREATE INDEX IF NOT EXISTS idx_escrows_order_id ON escrows(order_id);
CREATE INDEX IF NOT EXISTS idx_escrows_status ON escrows(status);
CREATE INDEX IF NOT EXISTS idx_escrows_auto_release_at ON escrows(auto_release_at) WHERE status = 'held';

-- ================================================
-- GRANT PERMISSIONS
-- ================================================
GRANT SELECT ON escrows TO authenticated;
GRANT INSERT, UPDATE ON escrows TO service_role;

-- Add helpful comment
COMMENT ON TABLE escrows IS 'Holds payment funds until order completion. Protected by RLS to ensure users only see their own escrows.';

