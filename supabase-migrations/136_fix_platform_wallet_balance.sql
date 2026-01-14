-- =====================================================
-- FIX PLATFORM WALLET BALANCE DISCREPANCY
-- Manually credit platform wallet with missing commission funds
-- Revenue shows $4.40 but wallet shows $0.00 - this corrects the balance
-- =====================================================

BEGIN;

-- Platform user ID constant
DO $$
DECLARE
  platform_user_id UUID := '00000000-0000-4000-8000-000000000002'::UUID;
  platform_wallet_id UUID;
  current_balance DECIMAL;
  expected_balance DECIMAL;
  discrepancy DECIMAL;
  transaction_id UUID;
BEGIN
  -- Get platform wallet ID and current balance
  SELECT id, available_balance INTO platform_wallet_id, current_balance
  FROM wallets
  WHERE user_id = platform_user_id;

  IF platform_wallet_id IS NULL THEN
    RAISE EXCEPTION 'Platform wallet not found for user %', platform_user_id;
  END IF;

  -- Calculate expected balance: sum of all platform commissions from released escrows
  SELECT COALESCE(SUM(platform_amount), 0) INTO expected_balance
  FROM escrows
  WHERE status = 'released'
    AND platform_amount > 0;

  -- Calculate discrepancy
  discrepancy := expected_balance - current_balance;

  RAISE NOTICE 'Platform wallet analysis:';
  RAISE NOTICE '  Current balance: %', current_balance;
  RAISE NOTICE '  Expected balance: %', expected_balance;
  RAISE NOTICE '  Discrepancy: %', discrepancy;

  -- If there's a discrepancy, credit the missing amount
  IF discrepancy > 0 THEN
    RAISE NOTICE 'Crediting platform wallet with missing % FRETI', discrepancy;

    -- Create wallet ledger entry for the correction
    INSERT INTO wallet_ledger (
      id, wallet_id, user_id, transaction_type,
      available_delta, escrow_delta, pending_withdrawal_delta,
      available_balance_after, escrow_balance_after, pending_withdrawal_after,
      reference_type, reference_id, description, created_at
    ) VALUES (
      gen_random_uuid(),
      platform_wallet_id,
      platform_user_id,
      'platform_commission',  -- Use platform_commission type for consistency
      discrepancy, 0, 0,      -- Credit available balance
      current_balance + discrepancy, 0, 0,  -- New balances
      'correction', NULL,     -- Reference type and ID
      'Manual correction: Platform commissions from released escrows not credited to wallet',
      NOW()
    )
    RETURNING id INTO transaction_id;

    -- Update wallet balance
    UPDATE wallets
    SET available_balance = available_balance + discrepancy,
        updated_at = NOW()
    WHERE id = platform_wallet_id;

    RAISE NOTICE '✅ Platform wallet credited with % FRETI (Transaction: %)', discrepancy, transaction_id;
  ELSE
    RAISE NOTICE 'ℹ️ No discrepancy found - platform wallet balance is correct';
  END IF;

END $$;

COMMIT;

-- =====================================================
-- VERIFICATION QUERIES
-- =====================================================

-- Check final platform wallet balance
SELECT
  w.id as wallet_id,
  w.user_id,
  w.available_balance,
  w.preferred_currency,
  w.updated_at
FROM wallets w
WHERE w.user_id = '00000000-0000-4000-8000-000000000002';

-- Check the correction transaction
SELECT
  wl.id,
  wl.transaction_type,
  wl.available_delta,
  wl.available_balance_after,
  wl.description,
  wl.created_at
FROM wallet_ledger wl
WHERE wl.user_id = '00000000-0000-4000-8000-000000000002'
  AND wl.description LIKE '%Manual correction%'
ORDER BY wl.created_at DESC
LIMIT 1;

-- Verify total platform commissions match wallet balance
SELECT
  'Expected balance' as metric,
  COALESCE(SUM(e.platform_amount), 0) as amount
FROM escrows e
WHERE e.status = 'released' AND e.platform_amount > 0

UNION ALL

SELECT
  'Actual wallet balance' as metric,
  w.available_balance as amount
FROM wallets w
WHERE w.user_id = '00000000-0000-4000-8000-000000000002';
