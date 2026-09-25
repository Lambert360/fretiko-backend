BEGIN;

-- Migration 213: Align auction item precision and foreign keys
--
-- Why:
--   auction_items used DECIMAL(10,2) while auction_bids uses DECIMAL(18,6).
--   The bid trigger stores bid amounts into auction_items.current_bid/winning_bid,
--   causing silent rounding and off-by-small-amount inconsistencies.
--   auction_items.winner_id and user_auction_wins.user_id referenced auth.users(id)
--   while the rest of the auction system uses user_profiles(id).

-- 1. Increase precision in auction_items to match auction_bids
ALTER TABLE auction_items
  ALTER COLUMN starting_price TYPE DECIMAL(18,6) USING starting_price::DECIMAL(18,6),
  ALTER COLUMN reserve_price TYPE DECIMAL(18,6) USING reserve_price::DECIMAL(18,6),
  ALTER COLUMN current_bid TYPE DECIMAL(18,6) USING current_bid::DECIMAL(18,6),
  ALTER COLUMN winning_bid TYPE DECIMAL(18,6) USING winning_bid::DECIMAL(18,6),
  ALTER COLUMN bid_increment TYPE DECIMAL(18,6) USING bid_increment::DECIMAL(18,6);

-- 2. Increase precision in user_auction_wins to match auction_bids
ALTER TABLE user_auction_wins
  ALTER COLUMN winning_bid TYPE DECIMAL(18,6) USING winning_bid::DECIMAL(18,6);

-- 3. Enforce deterministic item ordering
ALTER TABLE auction_items
  ADD CONSTRAINT unique_auction_item_order UNIQUE (auction_id, order_in_auction);

-- 4. Align foreign keys to user_profiles
ALTER TABLE auction_items
  DROP CONSTRAINT IF EXISTS auction_items_winner_id_fkey,
  ADD CONSTRAINT auction_items_winner_id_fkey
    FOREIGN KEY (winner_id) REFERENCES user_profiles(id) ON DELETE SET NULL;

ALTER TABLE user_auction_wins
  DROP CONSTRAINT IF EXISTS user_auction_wins_user_id_fkey,
  ADD CONSTRAINT user_auction_wins_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES user_profiles(id) ON DELETE CASCADE;

COMMIT;
