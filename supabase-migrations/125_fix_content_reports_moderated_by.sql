-- Migration: Fix content_reports.moderated_by to support staff accounts
-- The moderated_by column currently references auth.users(id), but staff moderators
-- have IDs in staff_accounts, not auth.users. This migration:
-- 1. Drops the foreign key constraint
-- 2. Changes the column to allow NULL and reference staff_accounts instead
-- 3. Adds a comment explaining the change

-- Drop the existing foreign key constraint
ALTER TABLE public.content_reports 
  DROP CONSTRAINT IF EXISTS content_reports_moderated_by_fkey;

-- The column can now store either:
-- - NULL (if not moderated yet, or if moderated by staff without auth.users entry)
-- - A UUID from staff_accounts (for staff moderators)
-- - A UUID from auth.users (for user moderators, if any exist)

-- Note: We're not adding a new foreign key constraint because:
-- 1. Staff accounts might not have corresponding auth.users entries
-- 2. We want flexibility to support both staff and user moderators
-- 3. The application layer will validate the moderator ID

COMMENT ON COLUMN public.content_reports.moderated_by IS 
  'ID of the moderator who reviewed this report. Can be from staff_accounts (for staff) or auth.users (for user moderators). NULL if not yet moderated.';

