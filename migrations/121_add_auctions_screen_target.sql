-- Migration: Add 'auctions' screen target and countdown support to sign posts
-- Date: 2026-08-25
-- Description: Allow sign posts/hero banners to target the Auction Discovery screen and support live countdown overlays

-- Add countdown support to sign posts
ALTER TABLE sign_posts
  ADD COLUMN IF NOT EXISTS countdown_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS countdown_target TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN sign_posts.countdown_enabled IS 'Whether to display a live countdown overlay on this sign post';
COMMENT ON COLUMN sign_posts.countdown_target IS 'Target date/time for the countdown overlay';

-- Update screen target check constraint to include auctions
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'sign_posts'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%screen_target%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE sign_posts DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE sign_posts
  ADD CONSTRAINT sign_posts_screen_target_check
  CHECK (screen_target IN ('home', 'products', 'live_sales', 'auctions', 'all'));

COMMENT ON COLUMN sign_posts.screen_target IS 'Which app screen the sign post appears on: home, products, live_sales, auctions, all';
