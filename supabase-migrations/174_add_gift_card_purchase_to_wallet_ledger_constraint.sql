-- =====================================================
-- Migration: 174
-- Fix: Add gift_card_purchase to wallet_ledger transaction_type check constraint
-- Description:
--   Migration 173 added gift_card_purchase support to the
--   process_wallet_transaction SQL function, but the
--   wallet_ledger.transaction_type column still has a CHECK
--   constraint from migration 145 that does not list
--   'gift_card_purchase'. This causes user gift card purchases
--   (and admin marketing wallet debits) to fail with:
--     "new row for relation wallet_ledger violates check constraint
--      wallet_ledger_transaction_type_check"
--
--   This migration updates the CHECK constraint to include
--   'gift_card_purchase' alongside the existing gift_purchase and
--   other transaction types.
-- =====================================================

BEGIN;

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
    'gift_card_purchase',
    -- Transfers
    'purchase_hold',
    'withdrawal_request',
    'escrow_release_to_platform'
  ));

COMMIT;
