BEGIN;

-- =====================================================
-- CREATE USER AUCTION WINS SYSTEM
-- Migration: 143
-- Date: 2025-01-XX
-- Description: Persist won auction items for both live and timed auctions
-- Allows users to recover won items across sessions
-- =====================================================

-- Create user_auction_wins table
CREATE TABLE IF NOT EXISTS user_auction_wins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  
  -- For multi-item live auctions
  item_id UUID REFERENCES auction_items(id) ON DELETE SET NULL,
  
  -- Win Information
  winning_bid DECIMAL(10,2) NOT NULL,
  won_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Status tracking
  status VARCHAR(50) DEFAULT 'pending_checkout' CHECK (status IN ('pending_checkout', 'checked_out', 'expired', 'cancelled')),
  
  -- Order linking (after checkout)
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  
  -- Expiration (wins expire after 7 days if not checked out)
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '7 days'),
  
  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add unique constraint to prevent duplicate wins (same user, auction, and item)
-- Note: PostgreSQL treats NULLs as distinct, so we use a unique partial index
-- to handle NULL item_id (timed auctions) vs non-NULL (multi-item live auctions)
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_auction_wins_unique_with_item ON user_auction_wins(user_id, auction_id, item_id) WHERE item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_auction_wins_unique_without_item ON user_auction_wins(user_id, auction_id) WHERE item_id IS NULL;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_auction_wins_user_id ON user_auction_wins(user_id);
CREATE INDEX IF NOT EXISTS idx_user_auction_wins_auction_id ON user_auction_wins(auction_id);
CREATE INDEX IF NOT EXISTS idx_user_auction_wins_item_id ON user_auction_wins(item_id) WHERE item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_auction_wins_status ON user_auction_wins(status);
CREATE INDEX IF NOT EXISTS idx_user_auction_wins_expires_at ON user_auction_wins(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_auction_wins_user_status ON user_auction_wins(user_id, status);

-- Add RLS policies for user_auction_wins
ALTER TABLE user_auction_wins ENABLE ROW LEVEL SECURITY;

-- Policy: Users can read their own wins
CREATE POLICY "user_auction_wins_read_own" ON user_auction_wins
  FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: Service role can manage all wins (for system operations)
CREATE POLICY "user_auction_wins_service_role_admin" ON user_auction_wins
  FOR ALL
  USING (auth.role() = 'service_role');

-- Policy: Users can update their own wins (for marking as checked out)
CREATE POLICY "user_auction_wins_update_own" ON user_auction_wins
  FOR UPDATE
  USING (auth.uid() = user_id);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_user_auction_wins_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for updated_at
CREATE TRIGGER user_auction_wins_updated_at_trigger
  BEFORE UPDATE ON user_auction_wins
  FOR EACH ROW
  EXECUTE FUNCTION update_user_auction_wins_updated_at();

-- Create function to automatically expire old wins (called by cron job)
CREATE OR REPLACE FUNCTION expire_old_auction_wins()
RETURNS INTEGER AS $$
DECLARE
  expired_count INTEGER;
BEGIN
  UPDATE user_auction_wins
  SET status = 'expired',
      updated_at = NOW()
  WHERE status = 'pending_checkout'
    AND expires_at < NOW();
  
  GET DIAGNOSTICS expired_count = ROW_COUNT;
  RETURN expired_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Note: Duplicate prevention is handled by unique indexes above

COMMIT;

