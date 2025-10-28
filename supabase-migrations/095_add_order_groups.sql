-- Create order_groups table for multi-vendor checkout
CREATE TABLE IF NOT EXISTS order_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_number VARCHAR UNIQUE NOT NULL,
  buyer_id UUID NOT NULL REFERENCES user_profiles(id),
  total_amount NUMERIC NOT NULL,
  total_orders INTEGER NOT NULL,
  delivery_address JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add order group columns to orders table
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_group_id UUID REFERENCES order_groups(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_grouped BOOLEAN DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS group_sequence INTEGER;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_orders_group_id ON orders(order_group_id);
CREATE INDEX IF NOT EXISTS idx_order_groups_buyer ON order_groups(buyer_id);

-- Add comment for documentation
COMMENT ON TABLE order_groups IS 'Groups multiple orders from different vendors into a single checkout transaction';
COMMENT ON COLUMN orders.order_group_id IS 'Links order to its parent group for multi-vendor checkouts';
COMMENT ON COLUMN orders.is_grouped IS 'Indicates if this order is part of a multi-vendor group';
COMMENT ON COLUMN orders.group_sequence IS 'Sequential position of order within its group (1, 2, 3, etc.)';

