-- Migration: Update wallet_ledger transaction_type CHECK constraint
-- Date: 2025-01-XX
-- Description: Add 'delivery_payment' and 'platform_commission' to allowed transaction types
--
-- This migration updates the CHECK constraint on wallet_ledger.transaction_type
-- to include 'delivery_payment' (for rider payments) and 'platform_commission'
-- (for platform fee credits)

BEGIN;

-- Drop the existing CHECK constraint (PostgreSQL auto-generates the name)
-- We'll find it by constraint type and column
DO $$
DECLARE
    constraint_name TEXT;
    column_attnum SMALLINT;
BEGIN
    -- Get the attribute number for transaction_type column
    SELECT attnum INTO column_attnum
    FROM pg_attribute
    WHERE attrelid = 'wallet_ledger'::regclass
      AND attname = 'transaction_type';

    -- Find the constraint name for transaction_type CHECK constraint
    SELECT conname INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = 'wallet_ledger'::regclass
      AND contype = 'c'
      AND conkey = ARRAY[column_attnum];

    -- Drop the constraint if it exists
    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE wallet_ledger DROP CONSTRAINT %I', constraint_name);
        RAISE NOTICE 'Dropped constraint: %', constraint_name;
    ELSE
        RAISE NOTICE 'No CHECK constraint found on transaction_type column';
    END IF;
END $$;

-- Add the new CHECK constraint with updated transaction types
ALTER TABLE wallet_ledger
ADD CONSTRAINT wallet_ledger_transaction_type_check
CHECK (transaction_type IN (
    'deposit_mint',
    'withdrawal_burn',
    'purchase_hold',
    'escrow_release',
    'escrow_refund',
    'admin_adjustment',
    'fee_deduction',
    'reward_credit',
    'delivery_payment',      -- ✅ Added for rider delivery payments
    'platform_commission'    -- ✅ Added for platform fee credits
));

COMMENT ON CONSTRAINT wallet_ledger_transaction_type_check ON wallet_ledger IS
'Ensures transaction_type is one of the valid wallet transaction types including delivery_payment and platform_commission';

COMMIT;

