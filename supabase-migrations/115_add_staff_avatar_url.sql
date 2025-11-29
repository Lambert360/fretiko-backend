-- =====================================================
-- Add avatar_url to staff_accounts table
-- =====================================================
-- This migration adds avatar_url field to staff_accounts for profile pictures

ALTER TABLE public.staff_accounts
ADD COLUMN IF NOT EXISTS avatar_url TEXT;

COMMENT ON COLUMN public.staff_accounts.avatar_url IS 'URL to staff profile picture stored in Supabase Storage';

