BEGIN;

-- =====================================================
-- MIGRATION: 233
-- vendor_leaderboard_cache: add denormalized vendor profile columns
--
-- Why:
--   LiveSalesGamificationService writes vendor_name + avatar_url into the
--   leaderboard cache so reads don't join user_profiles, but the live table
--   was created without them — every 15-minute recalculation fails with
--   PGRST204 "Could not find the 'avatar_url' column".
-- =====================================================

ALTER TABLE public.vendor_leaderboard_cache
  ADD COLUMN IF NOT EXISTS vendor_name TEXT,
  ADD COLUMN IF NOT EXISTS avatar_url TEXT;

COMMIT;
