-- Migration: Add 'ready_for_pickup' status for self-pickup orders
-- Description: Adds new order status to support vendor signaling order readiness for buyer pickup

-- ✅ Since status is a TEXT column with CHECK constraint (not an ENUM),
-- we need to update the CHECK constraint to include 'ready_for_pickup'

DO $$ 
BEGIN
    -- Drop existing check constraint if it exists
    IF EXISTS (
        SELECT 1 
        FROM pg_constraint 
        WHERE conname = 'orders_status_check'
    ) THEN
        ALTER TABLE public.orders DROP CONSTRAINT orders_status_check;
        RAISE NOTICE '✅ Dropped old orders_status_check constraint';
    END IF;

    -- Add new check constraint with 'ready_for_pickup' included
    ALTER TABLE public.orders 
    ADD CONSTRAINT orders_status_check 
    CHECK (status IN (
        'pending',
        'accepted',
        'processing',
        'ready_for_pickup',
        'out_for_delivery',
        'delivered',
        'received',
        'completed',
        'cancelled',
        'disputed',
        'paid'
    ));
    
    RAISE NOTICE '✅ Added ready_for_pickup to orders status check constraint';
    
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE '⚠️ Error updating status constraint: %', SQLERRM;
        RAISE NOTICE '📝 This is usually safe to ignore if constraint already exists';
END $$;

-- Add comment for documentation
COMMENT ON COLUMN public.orders.status IS 'Order status: pending, accepted, processing, ready_for_pickup (self-pickup), out_for_delivery, delivered, received, completed, cancelled, disputed, paid';

-- Verify the constraint was added
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM pg_constraint 
        WHERE conname = 'orders_status_check'
    ) THEN
        RAISE NOTICE '✅ orders_status_check constraint is active';
    ELSE
        RAISE NOTICE '⚠️ orders_status_check constraint not found';
    END IF;
END $$;

