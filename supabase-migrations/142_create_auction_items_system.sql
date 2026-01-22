BEGIN;

-- Create auction_items table for multi-item live auctions
CREATE TABLE IF NOT EXISTS auction_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  
  -- Item Information
  title VARCHAR(255) NOT NULL,
  description TEXT,
  lot_number VARCHAR(50),
  starting_price DECIMAL(10,2) NOT NULL,
  reserve_price DECIMAL(10,2),
  current_bid DECIMAL(10,2) DEFAULT 0,
  bid_increment DECIMAL(10,2) NOT NULL DEFAULT 1.00,
  
  -- Item Status & Timing
  bidding_status VARCHAR(50) DEFAULT 'waiting' CHECK (bidding_status IN ('waiting', 'countdown', 'active', 'ended', 'sold', 'passed')),
  order_in_auction INTEGER NOT NULL,
  bidding_duration INTEGER DEFAULT 120, -- seconds for active bidding
  
  -- Timestamps
  countdown_started_at TIMESTAMP,
  bidding_started_at TIMESTAMP,
  bidding_ended_at TIMESTAMP,
  
  -- Media
  images TEXT[],
  video_url TEXT,
  
  -- Winner Information
  winner_id UUID REFERENCES auth.users(id),
  winning_bid DECIMAL(10,2),
  
  -- Metadata
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_auction_items_auction_id ON auction_items(auction_id);
CREATE INDEX IF NOT EXISTS idx_auction_items_bidding_status ON auction_items(bidding_status);
CREATE INDEX IF NOT EXISTS idx_auction_items_order_in_auction ON auction_items(auction_id, order_in_auction);
CREATE INDEX IF NOT EXISTS idx_auction_items_winner_id ON auction_items(winner_id);

-- Add current_item_id to auctions table
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS current_item_id UUID REFERENCES auction_items(id);

-- Add RLS policies for auction_items
ALTER TABLE auction_items ENABLE ROW LEVEL SECURITY;

-- Policy: Anyone can read auction items (public data)
CREATE POLICY "auction_items_public_read" ON auction_items
  FOR SELECT
  USING (true);

-- Policy: Only auction seller can insert/modify their auction items
CREATE POLICY "auction_items_seller_manage" ON auction_items
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM auctions
      WHERE auctions.id = auction_items.auction_id
      AND auctions.seller_id = auth.uid()
    )
  );

-- Policy: Service role can manage all auction items
CREATE POLICY "auction_items_service_role_admin" ON auction_items
  FOR ALL
  USING (auth.role() = 'service_role');

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_auction_items_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for updated_at
CREATE TRIGGER auction_items_updated_at_trigger
  BEFORE UPDATE ON auction_items
  FOR EACH ROW
  EXECUTE FUNCTION update_auction_items_updated_at();

-- Create function to get next waiting item in auction
CREATE OR REPLACE FUNCTION get_next_waiting_auction_item(p_auction_id UUID)
RETURNS UUID AS $$
DECLARE
  v_item_id UUID;
BEGIN
  SELECT id INTO v_item_id
  FROM auction_items
  WHERE auction_id = p_auction_id
    AND bidding_status = 'waiting'
  ORDER BY order_in_auction ASC
  LIMIT 1;
  
  RETURN v_item_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create function to get highest bidder for auction item
CREATE OR REPLACE FUNCTION get_item_highest_bidder(p_item_id UUID)
RETURNS TABLE (
  bidder_id UUID,
  amount DECIMAL(10,2),
  bidder_display_id VARCHAR(50)
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ab.bidder_id,
    ab.amount,
    ab.bidder_display_id
  FROM auction_bids ab
  WHERE ab.auction_id IN (
    SELECT auction_id FROM auction_items WHERE id = p_item_id
  )
  AND ab.amount = (
    SELECT MAX(amount)
    FROM auction_bids
    WHERE auction_id = ab.auction_id
  )
  ORDER BY ab.created_at DESC
  LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMIT;

