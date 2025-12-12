-- Migration: Add country field to user_bank_accounts
-- Date: 2025-12-10
-- Description: Add country code field to bank accounts for proper Flutterwave routing and validation

BEGIN;

-- Add country column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user_bank_accounts' 
        AND column_name = 'country'
    ) THEN
        ALTER TABLE user_bank_accounts 
        ADD COLUMN country VARCHAR(2); -- ISO country code (e.g., 'NG', 'GH', 'US')
        
        -- Add comment
        COMMENT ON COLUMN user_bank_accounts.country IS 'ISO 3166-1 alpha-2 country code for bank account location (e.g., NG, GH, US)';
        
        RAISE NOTICE 'Added country column to user_bank_accounts';
    ELSE
        RAISE NOTICE 'Country column already exists in user_bank_accounts';
    END IF;
END $$;

-- Update existing records: infer country from currency
-- Disable trigger temporarily to avoid conflict during bulk update
DO $$ 
BEGIN
    -- Temporarily disable the trigger that ensures single default account
    -- This trigger conflicts with bulk updates
    ALTER TABLE user_bank_accounts 
    DISABLE TRIGGER ensure_single_default_bank_account_trigger;
    
    -- Update existing records: infer country from currency
    UPDATE user_bank_accounts
    SET country = CASE currency
        WHEN 'NGN' THEN 'NG'
        WHEN 'GHS' THEN 'GH'
        WHEN 'KES' THEN 'KE'
        WHEN 'ZAR' THEN 'ZA'
        WHEN 'UGX' THEN 'UG'
        WHEN 'TZS' THEN 'TZ'
        WHEN 'RWF' THEN 'RW'
        WHEN 'XAF' THEN 'CM'  -- Central African CFA (Cameroon is most common)
        WHEN 'XOF' THEN 'SN'  -- West African CFA (Senegal is most common)
        WHEN 'USD' THEN 'US'
        WHEN 'EUR' THEN 'EU'
        WHEN 'GBP' THEN 'GB'
        WHEN 'CAD' THEN 'CA'
        WHEN 'AUD' THEN 'AU'
        ELSE NULL
    END
    WHERE country IS NULL;
    
    -- Re-enable the trigger
    ALTER TABLE user_bank_accounts 
    ENABLE TRIGGER ensure_single_default_bank_account_trigger;
    
    RAISE NOTICE 'Updated existing bank account records with country codes inferred from currency';
EXCEPTION
    WHEN OTHERS THEN
        -- Ensure trigger is re-enabled even if update fails
        ALTER TABLE user_bank_accounts 
        ENABLE TRIGGER ensure_single_default_bank_account_trigger;
        RAISE;
END $$;

COMMIT;

