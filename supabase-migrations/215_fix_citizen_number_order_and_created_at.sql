BEGIN;

-- =====================================================
-- MIGRATION: 215
-- Fix citizen number ordering and corrupted created_at values.
--
-- Root cause: updateProfile's upsert overwrote created_at on every profile
-- update, so user_profiles.created_at drifted from the true signup date.
-- Migration 214 backfilled citizen_number using that corrupted column.
--
-- Fix:
--  1. Restore user_profiles.created_at from auth.users.created_at
--     (the authoritative signup timestamp).
--  2. Reassign citizen_number ordered by auth.users.created_at so the
--     earliest signups hold the lowest numbers.
-- =====================================================

-- 1. Repair created_at from the authoritative auth.users timestamp
UPDATE user_profiles p
SET created_at = u.created_at
FROM auth.users u
WHERE p.id = u.id
  AND p.created_at IS DISTINCT FROM u.created_at;

-- 2. Reassign citizen numbers by true signup order.
--    LEFT JOIN keeps orphan profiles numbered (they sort last).
--    Phase A flips every number negative first so the unique index never
--    sees two rows holding the same positive value mid-update.
UPDATE user_profiles
SET citizen_number = -citizen_number
WHERE citizen_number > 0;

WITH ordered AS (
  SELECT p.id,
         row_number() OVER (ORDER BY u.created_at ASC NULLS LAST, p.id ASC) AS rn
  FROM user_profiles p
  LEFT JOIN auth.users u ON u.id = p.id
)
UPDATE user_profiles p
SET citizen_number = o.rn
FROM ordered o
WHERE p.id = o.id;

-- 3. Point the sequence past the highest assigned number
SELECT setval('citizen_number_seq',
              (SELECT COALESCE(MAX(citizen_number), 0) FROM user_profiles));

COMMIT;
