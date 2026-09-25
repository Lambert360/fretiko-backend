BEGIN;

-- =====================================================
-- MIGRATION: 235
-- vendor_leaderboard_cache: keep one snapshot per period
--
-- Why:
--   period_end is stamped with "now", so each recalc day produced a new
--   slice. Migration 234 only deduped within identical slices, leaving
--   one row per vendor PER DAY — the monthly tab interleaved snapshots
--   (two #1s with different stats). The leaderboard shows current
--   standings only, so each (period, event_name) should hold exactly
--   the newest recalculation batch. Rows in a batch share one
--   updated_at, so this keeps the latest batch per bucket.
-- =====================================================

DELETE FROM public.vendor_leaderboard_cache a
WHERE a.updated_at < (
  SELECT max(b.updated_at)
  FROM public.vendor_leaderboard_cache b
  WHERE b.period = a.period
    AND b.event_name IS NOT DISTINCT FROM a.event_name
);

COMMIT;
