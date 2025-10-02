-- Migration: Add Invoice Message Type and Order Source
-- Date: 2025-10-01
-- Description: Add 'invoice' to message types and orders source tracking

BEGIN;

-- Check if message_type constraint exists and update it
DO $$
BEGIN
    -- Drop existing constraint if it exists
    IF EXISTS (
        SELECT 1 FROM information_schema.constraint_column_usage
        WHERE table_name = 'chat_messages' AND constraint_name LIKE '%message_type%'
    ) THEN
        ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_message_type_check;
    END IF;

    -- Add new constraint with 'invoice' type
    ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_message_type_check
        CHECK (message_type IN ('text', 'image', 'video', 'file', 'audio', 'call', 'system', 'invoice'));
END $$;

-- Add source column to orders table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'orders' AND column_name = 'source'
    ) THEN
        ALTER TABLE orders ADD COLUMN source VARCHAR(30) DEFAULT 'regular'
            CHECK (source IN ('regular', 'live_stream', 'auction', 'service_booking', 'invoice'));
    ELSE
        -- Update existing constraint to include 'invoice'
        ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_source_check;
        ALTER TABLE orders ADD CONSTRAINT orders_source_check
            CHECK (source IN ('regular', 'live_stream', 'auction', 'service_booking', 'invoice'));
    END IF;
END $$;

-- Create index on orders.source for analytics queries
CREATE INDEX IF NOT EXISTS idx_orders_source ON orders(source);

-- Add invoice_id to orders metadata for tracking
COMMENT ON COLUMN orders.source IS 'Order source: regular, live_stream, auction, service_booking, or invoice';

COMMIT;
