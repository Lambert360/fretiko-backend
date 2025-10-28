-- =====================================================
-- ADD REWARDS TRACKING TO ORDERS TABLE
-- =====================================================
-- This migration adds the rewards_used column to track
-- how many rewards points were used for each order

-- Add rewards_used column to orders table
ALTER TABLE orders 
ADD COLUMN IF NOT EXISTS rewards_used DECIMAL(18,6) DEFAULT 0.000000;

-- Add comment
COMMENT ON COLUMN orders.rewards_used IS 'Amount of rewards points (⭐) used for this order';

-- Add index for querying orders with rewards
CREATE INDEX IF NOT EXISTS idx_orders_rewards_used 
ON orders(rewards_used) 
WHERE rewards_used > 0;

-- Verify the column was added
DO $$ 
BEGIN
    IF EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'orders' 
        AND column_name = 'rewards_used'
    ) THEN
        RAISE NOTICE '✅ rewards_used column added successfully to orders table';
    ELSE
        RAISE EXCEPTION '❌ Failed to add rewards_used column to orders table';
    END IF;
END $$;

