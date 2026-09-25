-- Migration 222: Auction soft-close dedup column + bid fraud metadata
--
-- 1. auctions.last_extended_at — the soft-close scheduler currently dedups
--    extensions on auctions.updated_at, but the bid trigger
--    (update_auction_stats_on_bid) bumps updated_at on EVERY bid. Rapid
--    sniping bids therefore suppress the extension exactly when it is needed.
--    A dedicated column fixes the race.
--
-- 2. auction_bids.ip_address / user_agent — the entity and fraud-detection
--    service already reference these columns but nothing guaranteed they
--    exist. Added IF NOT EXISTS so this is safe either way.
--
-- Additive, idempotent, transactional. Run BEFORE deploying the code that
-- reads/writes these columns.

BEGIN;

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS last_extended_at TIMESTAMPTZ NULL;

ALTER TABLE auction_bids
  ADD COLUMN IF NOT EXISTS ip_address TEXT NULL,
  ADD COLUMN IF NOT EXISTS user_agent TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_auction_bids_ip_address
  ON auction_bids(ip_address) WHERE ip_address IS NOT NULL;

COMMIT;
