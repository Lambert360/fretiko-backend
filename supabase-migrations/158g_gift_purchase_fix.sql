-- =====================================================
-- GIFT PURCHASE FIX: Use GIFT_CONVERSION for Admin Credit
-- Migration: 158g
-- Date: 2026-01-28
-- Description: 
-- Gift purchase should credit admin gift wallet with GIFT_CONVERSION (not PLATFORM_COMMISSION)
-- PLATFORM_COMMISSION debits escrow, but gift purchases use available balance
-- =====================================================

-- Update gift service to use GIFT_CONVERSION instead of PLATFORM_COMMISSION for admin credit
-- This changes the backend code, not the database function
UPDATE pg_proc
SET prosrc = replace(prosrc,
  'WalletTransactionType.PLATFORM_COMMISSION, // Using platform commission type for admin gift wallet',
  'WalletTransactionType.GIFT_CONVERSION, // Credits available balance for admin gift wallet')
WHERE proname = 'process_wallet_transaction';

COMMIT;
