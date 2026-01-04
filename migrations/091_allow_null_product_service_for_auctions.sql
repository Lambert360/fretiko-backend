-- Migration: Allow both product_id and service_id to be null for auction orders
-- Date: 2026-01-04
-- Description: Modify order_items constraint to allow both product_id and service_id to be null (for auctions)

-- Drop the existing constraint
ALTER TABLE order_items
DROP CONSTRAINT IF EXISTS order_items_product_or_service_check;

-- Add new constraint that allows both to be null (for auctions)
ALTER TABLE order_items
ADD CONSTRAINT order_items_product_or_service_check
CHECK (
  (product_id IS NOT NULL AND service_id IS NULL) OR
  (product_id IS NULL AND service_id IS NOT NULL) OR
  (product_id IS NULL AND service_id IS NULL) -- Allow both null for auctions
);

COMMENT ON CONSTRAINT order_items_product_or_service_check ON order_items IS 
'Ensures either product_id OR service_id is set, or both can be null for auction orders';

