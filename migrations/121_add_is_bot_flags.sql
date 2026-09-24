-- Flags bot-generated accounts and posts so they can be disclosed/filtered
-- (App Store review requires bot accounts to be identifiable). Run this once
-- in the Supabase SQL Editor for the target project.

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS is_bot_post BOOLEAN NOT NULL DEFAULT false;
