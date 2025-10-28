-- Migration: Add Constraints to Prevent Invalid Chat Participants
-- This migration adds database-level constraints to ensure data integrity
-- and prevent the "invalid input syntax for type uuid" error from occurring again
--
-- Run this AFTER migration 074_clean_invalid_chat_participants.sql
--
-- Author: Claude Code
-- Date: 2025-10-19

BEGIN;

-- =============================================================================
-- STEP 1: Add NOT NULL Constraint to user_id
-- =============================================================================

-- Ensure user_id cannot be NULL
-- Note: This should already exist, but we're being explicit
ALTER TABLE chat_participants
ALTER COLUMN user_id SET NOT NULL;

DO $$
BEGIN
  RAISE NOTICE '✅ Added NOT NULL constraint to user_id';
END $$;

-- =============================================================================
-- STEP 2: Add Check Constraint for Valid UUID Format
-- =============================================================================

-- Add constraint to ensure user_id is a valid UUID format
-- This prevents string "null", "undefined", empty strings, and malformed UUIDs
ALTER TABLE chat_participants
ADD CONSTRAINT chat_participants_valid_user_id CHECK (
  user_id IS NOT NULL
  AND user_id::text != 'null'
  AND user_id::text != 'undefined'
  AND user_id::text != ''
  AND user_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);

DO $$
BEGIN
  RAISE NOTICE '✅ Added valid UUID format constraint to user_id';
END $$;

-- =============================================================================
-- STEP 3: Add Check Constraint for Valid conversation_id
-- =============================================================================

-- Also ensure conversation_id is valid (belt and suspenders approach)
ALTER TABLE chat_participants
ADD CONSTRAINT chat_participants_valid_conversation_id CHECK (
  conversation_id IS NOT NULL
  AND conversation_id::text != 'null'
  AND conversation_id::text != 'undefined'
  AND conversation_id::text != ''
  AND conversation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);

DO $$
BEGIN
  RAISE NOTICE '✅ Added valid UUID format constraint to conversation_id';
END $$;

-- =============================================================================
-- STEP 4: Add Function to Validate UUIDs on Insert/Update
-- =============================================================================

-- Create a function that validates UUIDs more comprehensively
CREATE OR REPLACE FUNCTION validate_chat_participant_uuids()
RETURNS TRIGGER AS $$
BEGIN
  -- Validate user_id
  IF NEW.user_id IS NULL OR
     NEW.user_id::text = 'null' OR
     NEW.user_id::text = 'undefined' OR
     NEW.user_id::text = '' OR
     NOT (NEW.user_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'Invalid user_id: must be a valid UUID, got "%"', NEW.user_id;
  END IF;

  -- Validate conversation_id
  IF NEW.conversation_id IS NULL OR
     NEW.conversation_id::text = 'null' OR
     NEW.conversation_id::text = 'undefined' OR
     NEW.conversation_id::text = '' OR
     NOT (NEW.conversation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'Invalid conversation_id: must be a valid UUID, got "%"', NEW.conversation_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to run validation on every insert/update
DROP TRIGGER IF EXISTS validate_chat_participant_uuids_trigger ON chat_participants;
CREATE TRIGGER validate_chat_participant_uuids_trigger
  BEFORE INSERT OR UPDATE ON chat_participants
  FOR EACH ROW
  EXECUTE FUNCTION validate_chat_participant_uuids();

DO $$
BEGIN
  RAISE NOTICE '✅ Created trigger to validate UUIDs on insert/update';
END $$;

-- =============================================================================
-- STEP 5: Add Foreign Key Constraint (if not already exists)
-- =============================================================================

-- Ensure user_id references a real user in auth.users
-- This prevents orphaned participants
DO $$
BEGIN
  -- Check if foreign key already exists
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'chat_participants_user_id_fkey'
    AND table_name = 'chat_participants'
  ) THEN
    ALTER TABLE chat_participants
    ADD CONSTRAINT chat_participants_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

    RAISE NOTICE '✅ Added foreign key constraint for user_id';
  ELSE
    RAISE NOTICE 'ℹ️  Foreign key constraint already exists for user_id';
  END IF;
END $$;

-- =============================================================================
-- STEP 6: Verify Constraints
-- =============================================================================

-- Test the constraints by attempting to insert invalid data (should fail)
DO $$
BEGIN
  -- This should fail with our new constraints
  BEGIN
    INSERT INTO chat_participants (conversation_id, user_id)
    VALUES ('00000000-0000-0000-0000-000000000000', 'null');
    RAISE EXCEPTION 'Constraint validation FAILED - invalid data was inserted!';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE '✅ Constraint validation PASSED - invalid data was rejected';
    WHEN OTHERS THEN
      RAISE NOTICE '✅ Constraint validation PASSED - invalid data was rejected with error: %', SQLERRM;
  END;
END $$;

-- =============================================================================
-- STEP 7: Log Final Status
-- =============================================================================

DO $$
DECLARE
  constraint_count INTEGER;
BEGIN
  -- Count constraints on chat_participants table
  SELECT COUNT(*)
  INTO constraint_count
  FROM information_schema.table_constraints
  WHERE table_name = 'chat_participants'
  AND constraint_type IN ('CHECK', 'FOREIGN KEY', 'PRIMARY KEY', 'UNIQUE');

  RAISE NOTICE '✅ Constraints migration complete!';
  RAISE NOTICE '📊 Total constraints on chat_participants: %', constraint_count;
  RAISE NOTICE '🛡️  Database is now protected against invalid UUID data';
END $$;

COMMIT;

-- =============================================================================
-- ROLLBACK INSTRUCTIONS
-- =============================================================================
-- To rollback this migration, run:
--
-- BEGIN;
-- ALTER TABLE chat_participants DROP CONSTRAINT IF EXISTS chat_participants_valid_user_id;
-- ALTER TABLE chat_participants DROP CONSTRAINT IF EXISTS chat_participants_valid_conversation_id;
-- DROP TRIGGER IF EXISTS validate_chat_participant_uuids_trigger ON chat_participants;
-- DROP FUNCTION IF EXISTS validate_chat_participant_uuids();
-- COMMIT;
-- =============================================================================
