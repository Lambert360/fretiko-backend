-- Migration: Enhance orders table for rider selection system
-- Date: 2025-01-15
-- Description: Add delivery type and rider info fields to support pickup vs delivery

-- Add delivery type field to distinguish between pickup and delivery
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_type VARCHAR(20) DEFAULT 'delivery' 
CHECK (delivery_type IN ('pickup', 'delivery'));

-- Add rider info as JSONB to store rider selection details
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_info JSONB DEFAULT NULL;

-- Update existing orders to have delivery type
UPDATE orders SET delivery_type = 'delivery' WHERE delivery_type IS NULL;

-- Add index for delivery type queries
CREATE INDEX IF NOT EXISTS idx_orders_delivery_type ON orders(delivery_type);

-- Add index for rider info queries  
CREATE INDEX IF NOT EXISTS idx_orders_rider_info ON orders USING GIN(rider_info);

-- Add comment to explain rider_info structure
COMMENT ON COLUMN orders.rider_info IS 'Stores rider selection details: {riderId, riderName, vehicleType, deliveryPrice, estimatedArrival}';

COMMIT;