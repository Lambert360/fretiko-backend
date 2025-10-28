-- Migration: Add 'wishlist' Message Type to Enum
-- This migration adds 'wishlist' to the message_type enum to support wishlist sharing in chat
--
-- Author: Claude Code
-- Date: 2025-10-19

BEGIN;

-- =============================================================================
-- STEP 1: Add 'wishlist' to message_type enum
-- =============================================================================

-- PostgreSQL doesn't allow direct ALTER TYPE for enums in transactions,
-- so we need to use a workaround for adding values safely

-- Add the new enum value
ALTER TYPE message_type ADD VALUE IF NOT EXISTS 'wishlist';

DO $$
BEGIN
  RAISE NOTICE '✅ Added "wishlist" to message_type enum';
END $$;

-- =============================================================================
-- STEP 2: Verify the enum now includes wishlist
-- =============================================================================

DO $$
DECLARE
  enum_values TEXT;
BEGIN
  -- Get all enum values
  SELECT string_agg(enumlabel, ', ' ORDER BY enumsortorder)
  INTO enum_values
  FROM pg_enum
  WHERE enumtypid = 'message_type'::regtype;

  RAISE NOTICE '📊 Current message_type enum values: %', enum_values;

  -- Check if wishlist was added
  IF enum_values LIKE '%wishlist%' THEN
    RAISE NOTICE '✅ Enum update successful - wishlist type is now available';
  ELSE
    RAISE EXCEPTION 'Enum update failed - wishlist not found in enum values';
  END IF;
END $$;

COMMIT;

-- =============================================================================
-- ROLLBACK INSTRUCTIONS
-- =============================================================================
-- Note: PostgreSQL does NOT support removing enum values easily.
-- If you need to rollback, you would need to:
-- 1. Ensure no messages use messageType = 'wishlist'
-- 2. Create a new enum type without 'wishlist'
-- 3. Update all tables to use the new enum
-- 4. Drop the old enum
--
-- This is complex and risky - better to keep the enum value even if unused.
-- =============================================================================
