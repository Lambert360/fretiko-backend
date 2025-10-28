-- Migration: Fix wallet_ledger entries with missing wallet_id
-- Description: Updates wallet_ledger rows where wallet_id is NULL by matching user_id to wallets table
-- This fixes a bug where purchase transactions were recorded without wallet_id

-- Update wallet_ledger entries that have NULL wallet_id
-- by looking up the correct wallet_id from the wallets table
UPDATE wallet_ledger wl
SET wallet_id = w.id
FROM wallets w
WHERE wl.wallet_id IS NULL
  AND wl.user_id = w.user_id;

-- Log the number of updated rows
DO $$
DECLARE
  updated_count INTEGER;
BEGIN
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RAISE NOTICE 'Updated % wallet_ledger entries with missing wallet_id', updated_count;
END $$;

-- Add a comment explaining the column
COMMENT ON COLUMN wallet_ledger.wallet_id IS 'Reference to the wallet. Should always match the user_id via wallets table.';

-- Create an index on user_id for faster queries (if not already exists)
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user_id ON wallet_ledger(user_id);

-- Verify no NULL wallet_ids remain for users with wallets
DO $$
DECLARE
  remaining_nulls INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO remaining_nulls
  FROM wallet_ledger wl
  WHERE wl.wallet_id IS NULL
    AND EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = wl.user_id);
  
  IF remaining_nulls > 0 THEN
    RAISE WARNING 'Still have % wallet_ledger entries with NULL wallet_id for users with wallets!', remaining_nulls;
  ELSE
    RAISE NOTICE '✅ All wallet_ledger entries now have valid wallet_id';
  END IF;
END $$;

