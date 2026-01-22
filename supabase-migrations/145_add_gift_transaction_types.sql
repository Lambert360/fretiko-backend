BEGIN;

-- =====================================================
-- ADD GIFT TRANSACTION TYPES
-- Migration: 145
-- Date: 2025-01-20
-- Description: Add gift_purchase and gift_conversion transaction types
-- =====================================================

-- Add gift_purchase transaction type (debit)
ALTER TABLE wallet_ledger
  DROP CONSTRAINT IF EXISTS wallet_ledger_transaction_type_check;

ALTER TABLE wallet_ledger
  ADD CONSTRAINT wallet_ledger_transaction_type_check
  CHECK (transaction_type IN (
    -- Credits
    'deposit_mint',
    'escrow_release',
    'escrow_refund',
    'reward_credit',
    'admin_adjustment',
    'delivery_payment',
    'platform_commission',
    'gift_conversion',
    -- Debits
    'withdrawal_burn',
    'fee_deduction',
    'gift_purchase',
    -- Transfers
    'purchase_hold',
    'withdrawal_request',
    'escrow_release_to_platform'
  ));

COMMIT;

