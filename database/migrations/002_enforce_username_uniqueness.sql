-- Migration: Enforce unique, case-insensitive usernames
-- Run this in the Supabase SQL Editor

-- 1. Normalize all existing usernames to lowercase
UPDATE public.user_profiles
SET username = LOWER(username)
WHERE username IS NOT NULL
  AND username <> LOWER(username);

-- 2. Resolve any case-insensitive collisions that now appear identical
-- (append a 4-char hex suffix to all but the earliest duplicate)
WITH ranked AS (
  SELECT
    id,
    username,
    ROW_NUMBER() OVER (
      PARTITION BY LOWER(username)
      ORDER BY created_at ASC
    ) AS rn
  FROM public.user_profiles
  WHERE username IS NOT NULL
),
duplicates AS (
  SELECT id FROM ranked WHERE rn > 1
)
UPDATE public.user_profiles p
SET username = p.username || '_' || LOWER(TO_HEX(FLOOR(RANDOM() * 65536)::INT))
FROM duplicates d
WHERE p.id = d.id;

-- 3. Add a case-insensitive unique index (citext-style via lower() expression)
--    Drop old index first if it exists, then recreate as case-insensitive
DROP INDEX IF EXISTS user_profiles_username_idx;

CREATE UNIQUE INDEX user_profiles_username_lower_idx
  ON public.user_profiles (LOWER(username))
  WHERE username IS NOT NULL;

-- 4. Replace handle_new_user trigger to generate collision-safe lowercase usernames
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    base_username TEXT;
    final_username TEXT;
BEGIN
    -- Derive base from provided username or email prefix, force lowercase
    base_username := COALESCE(
        LOWER(NEW.raw_user_meta_data->>'username'),
        LOWER(SPLIT_PART(NEW.email, '@', 1))
    );

    -- Strip characters not in [a-z0-9_], truncate to 40 chars
    base_username := REGEXP_REPLACE(base_username, '[^a-z0-9_]', '', 'g');
    base_username := LEFT(base_username, 40);

    -- Fallback if empty after stripping
    IF base_username = '' OR base_username IS NULL THEN
        base_username := 'user';
    END IF;

    final_username := base_username;

    -- Retry with random 4-char hex suffix until unique (case-insensitive)
    WHILE EXISTS (
        SELECT 1
        FROM public.user_profiles
        WHERE LOWER(username) = LOWER(final_username)
    ) LOOP
        final_username := base_username || '_' || LOWER(TO_HEX(FLOOR(RANDOM() * 65536)::INT));
    END LOOP;

    INSERT INTO public.user_profiles (id, username)
    VALUES (NEW.id, final_username);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger already exists from migration 001; recreating the function above is sufficient.
-- If needed, you can recreate the trigger:
-- DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
-- CREATE TRIGGER on_auth_user_created
--     AFTER INSERT ON auth.users
--     FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

COMMIT;
