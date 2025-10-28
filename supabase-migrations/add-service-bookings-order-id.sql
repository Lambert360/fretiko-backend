-- Add order_id column to service_bookings table to link bookings to orders/escrow
-- This enables service bookings to fully participate in the order/escrow/tracking system

-- Add order_id column (nullable for backward compatibility with existing bookings)
ALTER TABLE public.service_bookings 
ADD COLUMN IF NOT EXISTS order_id UUID;

-- Add foreign key constraint to orders table
ALTER TABLE public.service_bookings
ADD CONSTRAINT service_bookings_order_id_fkey 
FOREIGN KEY (order_id) 
REFERENCES public.orders(id) 
ON DELETE CASCADE;

-- Create index for faster order lookups
CREATE INDEX IF NOT EXISTS idx_service_bookings_order_id 
ON public.service_bookings(order_id);

-- Add comment for documentation
COMMENT ON COLUMN public.service_bookings.order_id IS 'Links service booking to unified order system for escrow and tracking';

