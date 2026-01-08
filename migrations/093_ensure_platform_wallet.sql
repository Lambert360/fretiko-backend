-- Migration: Ensure Platform Wallet Exists
-- Date: 2025-01-XX
-- Description: Create platform wallet if it doesn't exist to prevent commission payment failures
--
-- The platform wallet is used to receive platform commissions from escrow releases.
-- Platform User ID: 00000000-0000-4000-8000-000000000002

BEGIN;

-- Platform user ID constant
DO $$
DECLARE
  platform_user_id UUID := '00000000-0000-4000-8000-000000000002'::UUID;
  wallet_exists BOOLEAN;
  wallet_id UUID;
BEGIN
  -- Check if platform wallet exists
  SELECT EXISTS(
    SELECT 1 FROM wallets WHERE user_id = platform_user_id
  ) INTO wallet_exists;

  IF NOT wallet_exists THEN
    -- Create platform wallet
    INSERT INTO wallets (
      id,
      user_id,
      available_balance,
      escrow_balance,
      pending_withdrawal,
      preferred_currency,
      kyc_status,
      daily_deposit_limit,
      daily_withdrawal_limit,
      created_at,
      updated_at
    ) VALUES (
      gen_random_uuid(),
      platform_user_id,
      0.0,
      0.0,
      0.0,
      'USD',
      'approved', -- Platform wallet is always approved
      999999999.0, -- Very high limits for platform
      999999999.0,
      NOW(),
      NOW()
    )
    RETURNING id INTO wallet_id;

    RAISE NOTICE 'Platform wallet created with ID: %', wallet_id;
  ELSE
    RAISE NOTICE 'Platform wallet already exists';
    
    -- Ensure platform wallet has approved KYC status
    UPDATE wallets
    SET kyc_status = 'approved',
        updated_at = NOW()
    WHERE user_id = platform_user_id
      AND kyc_status != 'approved';
  END IF;
END $$;

-- Verify platform wallet exists
DO $$
DECLARE
  platform_user_id UUID := '00000000-0000-4000-8000-000000000002'::UUID;
  wallet_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO wallet_count
  FROM wallets
  WHERE user_id = platform_user_id;

  IF wallet_count = 0 THEN
    RAISE EXCEPTION 'Failed to create platform wallet';
  END IF;

  RAISE NOTICE 'Platform wallet verification: % wallet(s) found', wallet_count;
END $$;

COMMIT;

