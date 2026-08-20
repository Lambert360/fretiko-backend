-- Adds display-only follower/following counters to user_profiles.
-- Used by the bot network (and future real follow feature) to show
-- realistic follower counts on profiles. Run this once in the Supabase
-- SQL Editor for the target project.

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS followers_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS following_count INTEGER NOT NULL DEFAULT 0;
