-- Migration: Fix auction bidding system - trigger and proxy bid support
-- Date: 2025-01-30
-- Description: 
--  1. Fix auction stats trigger to use SECURITY DEFINER and add bid validation
--  2. Ensure proper current_bid updates and statistics tracking

BEGIN;

-- Drop existing trigger and function
DROP TRIGGER IF EXISTS trigger_update_auction_stats_on_bid ON auction_bids;
DROP FUNCTION IF EXISTS update_auction_stats_on_bid();

-- Recreate the trigger function with SECURITY DEFINER and validation
-- This allows the trigger to bypass RLS policies when updating auction stats
CREATE OR REPLACE FUNCTION update_auction_stats_on_bid()
RETURNS TRIGGER 
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
DECLARE
  current_max_bid DECIMAL(18,6);
  current_bid_increment DECIMAL(18,6);
  auction_starting_price DECIMAL(18,6);
BEGIN
  -- Get the current highest valid bid, bid increment, and starting price for this auction
  SELECT 
    COALESCE(MAX(ab.amount), a.starting_price - a.bid_increment, 0),
    a.bid_increment,
    a.starting_price
  INTO current_max_bid, current_bid_increment, auction_starting_price
  FROM auctions a
  LEFT JOIN auction_bids ab ON ab.auction_id = a.id 
    AND ab.is_valid = true 
    AND ab.id != NEW.id  -- Exclude the current bid being inserted
  WHERE a.id = NEW.auction_id
  GROUP BY a.id, a.starting_price, a.bid_increment;

  -- Database-level validation: Ensure bid meets minimum requirement
  -- Minimum bid is current_max_bid + bid_increment (or starting_price if no bids yet)
  IF current_max_bid = 0 THEN
    -- First bid must be at least starting_price
    IF NEW.amount < auction_starting_price THEN
      RAISE EXCEPTION 'Bid amount %.2f is below starting price of %.2f', 
        NEW.amount, auction_starting_price;
    END IF;
  ELSE
    -- Subsequent bids must be at least current_max_bid + bid_increment
    IF NEW.amount < (current_max_bid + current_bid_increment) THEN
      RAISE EXCEPTION 'Bid amount %.2f is below minimum required bid of %.2f', 
        NEW.amount, (current_max_bid + current_bid_increment);
    END IF;
  END IF;

  -- Update auction stats (always update total_bids and unique_bidders)
  -- New bid is always higher due to validation above
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

  -- Mark all other bids as not winning
  UPDATE auction_bids
  SET is_winning = false
  WHERE auction_id = NEW.auction_id AND id != NEW.id;

  -- Mark this bid as winning
  UPDATE auction_bids
  SET is_winning = true
  WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

-- Recreate the trigger
CREATE TRIGGER trigger_update_auction_stats_on_bid
  AFTER INSERT ON auction_bids
  FOR EACH ROW
  EXECUTE FUNCTION update_auction_stats_on_bid();

-- Add comment explaining the function
COMMENT ON FUNCTION update_auction_stats_on_bid() IS 
  'Updates auction statistics when a new bid is placed. Uses SECURITY DEFINER to bypass RLS. Validates bid amounts at the database level.';

COMMIT;

