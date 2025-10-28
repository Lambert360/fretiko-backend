-- =====================================================
-- ADD ORDER PIN VERIFICATION SYSTEM
-- For secure handoff verification between vendor/rider/buyer
-- =====================================================

-- Add PIN columns to orders table (3-digit PINs)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_pin VARCHAR(3);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_pin VARCHAR(3);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_pin_verified_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_pin_verified_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_confirmed_at TIMESTAMP WITH TIME ZONE;

-- Add comments
COMMENT ON COLUMN orders.pickup_pin IS '3-digit PIN for vendor→rider handoff verification';
COMMENT ON COLUMN orders.delivery_pin IS '3-digit PIN for rider→buyer handoff verification';
COMMENT ON COLUMN orders.pickup_pin_verified_at IS 'Timestamp when pickup PIN was verified';
COMMENT ON COLUMN orders.delivery_pin_verified_at IS 'Timestamp when delivery PIN was verified';
COMMENT ON COLUMN orders.order_confirmed_at IS 'Timestamp when buyer received/confirmed the order (set immediately upon delivery PIN verification)';

-- =====================================================
-- VERIFICATION
-- =====================================================

-- Check the new columns
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'orders'
AND column_name IN ('pickup_pin', 'delivery_pin', 'pickup_pin_verified_at', 'delivery_pin_verified_at', 'order_confirmed_at');

