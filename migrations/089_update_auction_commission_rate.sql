-- Migration: Update auction default commission rate from 5% to 10%
-- Date: 2025-01-XX
-- Description: Standardize auction commission rate to 10% as per platform policy

BEGIN;

-- Update the DEFAULT value for commission_rate column
ALTER TABLE auctions 
ALTER COLUMN commission_rate SET DEFAULT 0.1000;

-- Optional: Update existing auctions that have the old default (5%)
-- Uncomment the following if you want to update existing auctions:
-- UPDATE auctions 
-- SET commission_rate = 0.1000 
-- WHERE commission_rate = 0.0500 
--   AND status IN ('scheduled', 'active');

COMMIT;

