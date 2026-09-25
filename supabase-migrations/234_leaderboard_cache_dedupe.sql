BEGIN;

-- =====================================================
-- MIGRATION: 234
-- vendor_leaderboard_cache: purge duplicate rows + NULL-safe unique index
--
-- Why:
--   The recalculation cron upserted with onConflict over
--   (vendor_id, period, period_start, period_end, event_name), but
--   event_name is NULL for daily/weekly/monthly periods and Postgres
--   ON CONFLICT never matches rows containing NULL — every 15-minute
--   run inserted a fresh row per vendor, so the leaderboard listed the
--   same vendor repeatedly. The service now delete+inserts per period
--   slice; this migration cleans the accumulated duplicates and adds a
--   NULL-safe unique index as a hard guarantee.
-- =====================================================

-- Keep only the most recently updated row per vendor/period slice
-- (IS NOT DISTINCT FROM treats NULL event_name values as equal).
DELETE FROM public.vendor_leaderboard_cache a
USING public.vendor_leaderboard_cache b
WHERE a.id <> b.id
  AND a.vendor_id = b.vendor_id
  AND a.period = b.period
  AND a.period_start = b.period_start
  AND a.period_end = b.period_end
  AND a.event_name IS NOT DISTINCT FROM b.event_name
  AND (a.updated_at < b.updated_at
       OR (a.updated_at = b.updated_at AND a.id < b.id));

CREATE UNIQUE INDEX IF NOT EXISTS ux_vendor_leaderboard_cache_slice
  ON public.vendor_leaderboard_cache
  (vendor_id, period, period_start, period_end, COALESCE(event_name, ''));

COMMIT;
