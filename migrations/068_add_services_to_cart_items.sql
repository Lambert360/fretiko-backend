-- Migration: Add service booking support to cart_items
-- Date: 2025-10-12
-- Description: Allow cart_items to hold both products and services with scheduling info

-- Make product_id nullable (since services won't have it)
ALTER TABLE cart_items
ALTER COLUMN product_id DROP NOT NULL;

-- Add service-related columns
ALTER TABLE cart_items
ADD COLUMN IF NOT EXISTS service_id UUID REFERENCES services(id) ON DELETE CASCADE,
ADD COLUMN IF NOT EXISTS scheduled_date TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS scheduled_time VARCHAR(50),
ADD COLUMN IF NOT EXISTS service_notes TEXT;

-- Drop old UNIQUE constraint on (user_id, product_id)
ALTER TABLE cart_items
DROP CONSTRAINT IF EXISTS cart_items_user_id_product_id_key;

-- Add new constraint: either product_id OR service_id must be set, not both
ALTER TABLE cart_items
ADD CONSTRAINT cart_items_product_or_service_check
CHECK (
  (product_id IS NOT NULL AND service_id IS NULL) OR
  (product_id IS NULL AND service_id IS NOT NULL)
);

-- Add unique constraints for both products and services
CREATE UNIQUE INDEX IF NOT EXISTS cart_items_user_product_unique
ON cart_items(user_id, product_id)
WHERE product_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cart_items_user_service_unique
ON cart_items(user_id, service_id)
WHERE service_id IS NOT NULL;

-- Create indexes for service queries
CREATE INDEX IF NOT EXISTS idx_cart_items_service_id ON cart_items(service_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_scheduled_date ON cart_items(scheduled_date);

-- Add comments for documentation
COMMENT ON COLUMN cart_items.service_id IS 'Service ID if this cart item is a service booking (mutually exclusive with product_id)';
COMMENT ON COLUMN cart_items.scheduled_date IS 'Scheduled date for service booking';
COMMENT ON COLUMN cart_items.scheduled_time IS 'Scheduled time for service booking (e.g., "2:00 PM")';
COMMENT ON COLUMN cart_items.service_notes IS 'Special notes/requests for the service booking';
