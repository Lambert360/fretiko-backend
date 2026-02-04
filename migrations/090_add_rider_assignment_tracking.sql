-- Migration: Add rider assignment tracking fields to orders table
-- Date: 2025-01-30
-- Description: Add fields for time-sensitive rider assignment tracking

-- Add rider assignment deadline tracking
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_assignment_deadline TIMESTAMP WITH TIME ZONE;

-- Add rider acceptance status tracking  
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_acceptance_status VARCHAR(20) DEFAULT 'pending' CHECK (rider_acceptance_status IN (
    'pending', 'accepted', 'rejected', 'timeout', 'reassigned'
));

-- Add replacement attempts counter
ALTER TABLE orders ADD COLUMN IF NOT EXISTS replacement_attempts INTEGER DEFAULT 0;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_orders_rider_assignment_deadline ON orders(rider_assignment_deadline);
CREATE INDEX IF NOT EXISTS idx_orders_rider_acceptance_status ON orders(rider_acceptance_status);
CREATE INDEX IF NOT EXISTS idx_orders_replacement_attempts ON orders(replacement_attempts);

-- Add comments for documentation
COMMENT ON COLUMN orders.rider_assignment_deadline IS 'Deadline for rider to accept assignment (5 minutes from assignment)';
COMMENT ON COLUMN orders.rider_acceptance_status IS 'Current status of rider assignment: pending, accepted, rejected, timeout, reassigned';
COMMENT ON COLUMN orders.replacement_attempts IS 'Number of replacement attempts made for this order';

COMMIT;
