-- Migration to add escrow_released_at column to orders table
-- This tracks when escrow funds were actually released to the vendor

BEGIN;

-- Add escrow_released_at column to orders table
ALTER TABLE public.orders 
ADD COLUMN IF NOT EXISTS escrow_released_at TIMESTAMPTZ;

-- Add index for querying orders by escrow release status
CREATE INDEX IF NOT EXISTS idx_orders_escrow_released_at 
ON public.orders(escrow_released_at) 
WHERE escrow_released_at IS NOT NULL;

-- Add comment to document the column
COMMENT ON COLUMN public.orders.escrow_released_at IS 'Timestamp when escrow funds were released to the vendor (buyer confirmed receipt)';

COMMIT;

