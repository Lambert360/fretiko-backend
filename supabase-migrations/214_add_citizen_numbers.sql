BEGIN;

-- =====================================================
-- MIGRATION: 214
-- Add sequential citizen numbers (FRT-000001 style) to user_profiles
-- - citizen_number: permanent, unique, never recycled (sequence-backed)
-- - citizen_number_seen_at: one-time reveal flag for existing/backfilled users
-- Existing users are backfilled in created_at order so the earliest
-- adopters receive the lowest numbers.
-- =====================================================

-- 1. Sequence that allocates citizen numbers. Only moves forward —
--    deleted accounts permanently retire their number.
--    CACHE 1000 keeps nextval() cheap under heavy signup bursts; discarded
--    cached values just become gaps, which citizen numbers don't care about.
CREATE SEQUENCE IF NOT EXISTS citizen_number_seq CACHE 1000;

-- Applied separately so re-runs still pick up the cache setting when the
-- sequence already exists.
ALTER SEQUENCE citizen_number_seq CACHE 1000;

-- 2. Columns
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS citizen_number bigint;

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS citizen_number_seen_at timestamptz;

-- 3. Backfill existing users in signup order (oldest gets the lowest number).
--    Numbers are offset by the current max so re-runs stay collision-free.
WITH ordered AS (
  SELECT id,
         row_number() OVER (ORDER BY created_at ASC NULLS LAST, id ASC) AS rn
  FROM user_profiles
  WHERE citizen_number IS NULL
),
maxn AS (
  SELECT COALESCE(MAX(citizen_number), 0) AS m FROM user_profiles
)
UPDATE user_profiles p
SET citizen_number = o.rn + maxn.m
FROM ordered o, maxn
WHERE p.id = o.id;

-- 4. Point the sequence past the highest backfilled number
SELECT setval('citizen_number_seq',
              (SELECT COALESCE(MAX(citizen_number), 0) FROM user_profiles));

-- 5. New profiles get a number automatically on INSERT via any code path
ALTER TABLE user_profiles
  ALTER COLUMN citizen_number SET DEFAULT nextval('citizen_number_seq'),
  ALTER COLUMN citizen_number SET NOT NULL;

ALTER SEQUENCE citizen_number_seq OWNED BY user_profiles.citizen_number;

-- 6. Uniqueness guarantee
CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_citizen_number_key
  ON user_profiles(citizen_number);

COMMIT;
