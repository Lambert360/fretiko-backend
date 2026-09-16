BEGIN;

-- =====================================================
-- MIGRATION: 209
-- Add item_id to auction_bids and auction_sales for multi-item live auctions
-- Update the bid stats trigger to be item-scoped
-- =====================================================

-- 1. Add item_id to auction_bids
ALTER TABLE auction_bids
  ADD COLUMN IF NOT EXISTS item_id UUID REFERENCES auction_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_auction_bids_item_id ON auction_bids(item_id);
CREATE INDEX IF NOT EXISTS idx_auction_bids_auction_item ON auction_bids(auction_id, item_id);

-- 2. Add item_id to auction_sales
ALTER TABLE auction_sales
  ADD COLUMN IF NOT EXISTS item_id UUID REFERENCES auction_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_auction_sales_item_id ON auction_sales(item_id);
CREATE INDEX IF NOT EXISTS idx_auction_sales_auction_item ON auction_sales(auction_id, item_id);

-- 3. Replace get_item_highest_bidder with an item-scoped version
DROP FUNCTION IF EXISTS get_item_highest_bidder(UUID);

CREATE OR REPLACE FUNCTION get_item_highest_bidder(p_item_id UUID)
RETURNS TABLE (
  bidder_id UUID,
  amount DECIMAL(10,2),
  bidder_display_id VARCHAR(50)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    ab.bidder_id,
    ab.amount,
    ab.bidder_display_id
  FROM auction_bids ab
  WHERE ab.item_id = p_item_id
    AND ab.is_valid = true
  ORDER BY ab.amount DESC, ab.created_at DESC
  LIMIT 1;
END;
$$;

-- 4. Replace the bid stats trigger to support item-scoped live bids
DROP TRIGGER IF EXISTS trigger_update_auction_stats_on_bid ON auction_bids;
DROP FUNCTION IF EXISTS update_auction_stats_on_bid();

CREATE OR REPLACE FUNCTION update_auction_stats_on_bid()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
  current_max_bid DECIMAL(18,6);
  current_bid_increment DECIMAL(18,6);
  starting_price DECIMAL(18,6);
BEGIN
  IF NEW.item_id IS NOT NULL THEN
    -- Live multi-item bid: validate and update against the specific item
    SELECT
      COALESCE(MAX(ab.amount), ai.starting_price - ai.bid_increment, 0),
      ai.bid_increment,
      ai.starting_price
    INTO current_max_bid, current_bid_increment, starting_price
    FROM auction_items ai
    LEFT JOIN auction_bids ab ON ab.item_id = ai.id
      AND ab.is_valid = true
      AND ab.id != NEW.id
    WHERE ai.id = NEW.item_id
    GROUP BY ai.id, ai.starting_price, ai.bid_increment;

    IF current_max_bid = 0 THEN
      IF NEW.amount < starting_price THEN
        RAISE EXCEPTION 'Bid amount %.2f is below starting price of %.2f',
          NEW.amount, starting_price;
      END IF;
    ELSE
      IF NEW.amount < (current_max_bid + current_bid_increment) THEN
        RAISE EXCEPTION 'Bid amount %.2f is below minimum required bid of %.2f',
          NEW.amount, (current_max_bid + current_bid_increment);
      END IF;
    END IF;

    UPDATE auction_items
    SET
      current_bid = NEW.amount,
      winner_id = NEW.bidder_id,
      winning_bid = NEW.amount,
      updated_at = NOW()
    WHERE id = NEW.item_id;
  ELSE
    -- Timed auction bid: validate and update against the whole auction
    SELECT
      COALESCE(MAX(ab.amount), a.starting_price - a.bid_increment, 0),
      a.bid_increment,
      a.starting_price
    INTO current_max_bid, current_bid_increment, starting_price
    FROM auctions a
    LEFT JOIN auction_bids ab ON ab.auction_id = a.id
      AND ab.is_valid = true
      AND ab.id != NEW.id
    WHERE a.id = NEW.auction_id
    GROUP BY a.id, a.starting_price, a.bid_increment;

    IF current_max_bid = 0 THEN
      IF NEW.amount < starting_price THEN
        RAISE EXCEPTION 'Bid amount %.2f is below starting price of %.2f',
          NEW.amount, starting_price;
      END IF;
    ELSE
      IF NEW.amount < (current_max_bid + current_bid_increment) THEN
        RAISE EXCEPTION 'Bid amount %.2f is below minimum required bid of %.2f',
          NEW.amount, (current_max_bid + current_bid_increment);
      END IF;
    END IF;
  END IF;

  -- Update auction-level stats
  UPDATE auctions
  SET
    current_bid = NEW.amount,
    winner_id = NEW.bidder_id,
    total_bids = total_bids + 1,
    unique_bidders = (
      SELECT COUNT(DISTINCT bidder_id)
      FROM auction_bids
      WHERE auction_id = NEW.auction_id AND is_valid = true
    ),
    updated_at = NOW()
  WHERE id = NEW.auction_id;

  -- Mark all other bids in the same scope as not winning
  UPDATE auction_bids
  SET is_winning = false
  WHERE auction_id = NEW.auction_id
    AND (item_id IS NOT DISTINCT FROM NEW.item_id)
    AND id != NEW.id;

  -- Mark this bid as winning
  UPDATE auction_bids
  SET is_winning = true
  WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_update_auction_stats_on_bid
  AFTER INSERT ON auction_bids
  FOR EACH ROW
  EXECUTE FUNCTION update_auction_stats_on_bid();

COMMIT;
