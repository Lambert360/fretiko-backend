-- Migration: Clean Invalid Chat Participants Data
-- This migration removes chat_participants records with invalid user_id values
-- and adds constraints to prevent future invalid data
--
-- Run this migration to fix the "invalid input syntax for type uuid: 'null'" error
--
-- Author: Claude Code
-- Date: 2025-10-19

BEGIN;

-- =============================================================================
-- STEP 1: Inspect Invalid Data (Log before deletion)
-- =============================================================================

-- Create a temporary table to log invalid data before deletion (for audit)
CREATE TEMP TABLE invalid_participants_audit AS
SELECT
  id,
  conversation_id,
  user_id,
  joined_at,
  CASE
    WHEN user_id IS NULL THEN 'NULL value'
    WHEN user_id::text = 'null' THEN 'String "null"'
    WHEN user_id::text = 'undefined' THEN 'String "undefined"'
    WHEN user_id::text = '' THEN 'Empty string'
    WHEN NOT (user_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN 'Invalid UUID format'
    ELSE 'Unknown issue'
  END as issue_type
FROM chat_participants
WHERE user_id IS NULL
   OR user_id::text = 'null'
   OR user_id::text = 'undefined'
   OR user_id::text = ''
   OR NOT (user_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

-- Log count of invalid participants
DO $$
DECLARE
  invalid_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO invalid_count FROM invalid_participants_audit;
  RAISE NOTICE '📊 Found % invalid chat_participants records', invalid_count;

  IF invalid_count > 0 THEN
    RAISE NOTICE '⚠️  These will be deleted in the next step';
  ELSE
    RAISE NOTICE '✅ No invalid records found - database is clean!';
  END IF;
END $$;

-- =============================================================================
-- STEP 2: Delete Invalid Participants
-- =============================================================================

-- Delete participants with NULL user_id
DELETE FROM chat_participants
WHERE user_id IS NULL;

-- Delete participants with string "null" as user_id
DELETE FROM chat_participants
WHERE user_id::text = 'null';

-- Delete participants with string "undefined" as user_id
DELETE FROM chat_participants
WHERE user_id::text = 'undefined';

-- Delete participants with empty string as user_id
DELETE FROM chat_participants
WHERE user_id::text = '';

-- Delete participants with invalid UUID format
DELETE FROM chat_participants
WHERE NOT (user_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

-- Log deletion results
DO $$
DECLARE
  deleted_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO deleted_count FROM invalid_participants_audit;
  RAISE NOTICE '🗑️  Deleted % invalid chat_participants records', deleted_count;
END $$;

-- =============================================================================
-- STEP 3: Clean Up Orphaned Conversations
-- =============================================================================

-- Delete conversations that have no valid participants left after cleanup
-- (These conversations are unusable without participants)
WITH orphaned_conversations AS (
  SELECT c.id
  FROM chat_conversations c
  LEFT JOIN chat_participants p ON p.conversation_id = c.id
  WHERE p.id IS NULL
)
DELETE FROM chat_conversations
WHERE id IN (SELECT id FROM orphaned_conversations);

-- Log orphaned conversations cleanup
DO $$
DECLARE
  orphaned_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphaned_count
  FROM chat_conversations c
  LEFT JOIN chat_participants p ON p.conversation_id = c.id
  WHERE p.id IS NULL;

  RAISE NOTICE '🧹 Cleaned up conversations with no valid participants';
END $$;

-- =============================================================================
-- STEP 4: Verify Data Integrity
-- =============================================================================

-- Log final statistics
DO $$
DECLARE
  total_participants INTEGER;
  total_conversations INTEGER;
  valid_conversations INTEGER;
BEGIN
  SELECT COUNT(*) INTO total_participants FROM chat_participants;
  SELECT COUNT(*) INTO total_conversations FROM chat_conversations;
  SELECT COUNT(DISTINCT conversation_id) INTO valid_conversations FROM chat_participants;

  RAISE NOTICE '✅ Data cleanup complete!';
  RAISE NOTICE '📊 Final statistics:';
  RAISE NOTICE '   - Total participants: %', total_participants;
  RAISE NOTICE '   - Total conversations: %', total_conversations;
  RAISE NOTICE '   - Conversations with valid participants: %', valid_conversations;
END $$;

COMMIT;

-- =============================================================================
-- ROLLBACK INSTRUCTIONS
-- =============================================================================
-- If you need to rollback, this migration does NOT support automatic rollback
-- because it deletes invalid data. You would need to restore from a backup.
--
-- IMPORTANT: Take a database backup before running this migration:
-- pg_dump your_database > backup_before_cleanup.sql
-- =============================================================================
