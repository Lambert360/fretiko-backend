-- Migration: Add 'wishlist' to orders.source enum
-- Date: 2025-01-XX
-- Description: Allow orders to have source 'wishlist' for wishlist gift purchases

BEGIN;

-- Drop existing source constraint if it exists
DO $$ 
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'orders_source_check'
    ) THEN
        ALTER TABLE orders DROP CONSTRAINT orders_source_check;
        RAISE NOTICE 'Dropped existing orders_source_check constraint';
    END IF;
END $$;

-- Add source constraint with wishlist option
ALTER TABLE orders ADD CONSTRAINT orders_source_check
    CHECK (source IN ('regular', 'live_stream', 'auction', 'service_booking', 'invoice', 'wishlist'));

COMMIT;

