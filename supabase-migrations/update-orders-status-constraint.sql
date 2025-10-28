-- =====================================================
-- UPDATE ORDERS STATUS CONSTRAINT
-- Fix order status values to support vendor/rider workflow
-- =====================================================

-- Drop the old constraint
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;

-- Add new constraint with workflow statuses
ALTER TABLE orders ADD CONSTRAINT orders_status_check
    CHECK (status IN (
        'pending',           -- ✅ Order created, awaiting vendor acceptance
        'processing',        -- ✅ Vendor accepted, preparing order
        'ready_for_pickup',  -- ✅ Order ready, awaiting rider pickup
        'out_for_delivery',  -- ✅ Rider picked up, delivering to buyer
        'delivered',         -- ✅ Delivered to buyer, awaiting confirmation
        'completed',         -- ✅ Buyer confirmed receipt, escrow released
        'cancelled',         -- ❌ Order cancelled
        -- Legacy statuses (for backward compatibility)
        'created',           -- Old: initial status
        'paid',              -- Old: payment confirmed
        'assigned',          -- Old: rider assigned
        'in_transit'         -- Old: in delivery
    ));

-- Add comment to explain the status flow
COMMENT ON COLUMN orders.status IS 'Order status flow: pending → processing → ready_for_pickup → out_for_delivery → delivered → completed (or cancelled at any stage)';

-- =====================================================
-- VERIFICATION
-- =====================================================

-- Check the constraint
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conname = 'orders_status_check';

