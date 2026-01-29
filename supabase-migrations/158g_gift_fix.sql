-- =====================================================
-- GIFT FIX: Platform Commission Credits Available Balance
-- Migration: 158g
-- Date: 2026-01-28
-- Description: Fix platform_commission to credit available balance instead of debiting escrow
-- This fixes gift purchase and gift conversion double debit issues
-- =====================================================

-- Fix platform_commission to credit available balance (not debit escrow)
UPDATE pg_proc
SET prosrc = replace(prosrc, 
  'WHEN ''platform_commission'' THEN
      v_available_delta := 0;
      v_escrow_delta := -p_amount;
      v_pending_delta := 0;
      v_new_available := v_current_available;
      v_new_escrow := v_current_escrow - p_amount;
      v_new_pending := v_current_pending;',
  'WHEN ''platform_commission'' THEN
      v_available_delta := p_amount;  -- ✅ FIXED: Credit available balance
      v_escrow_delta := 0;            -- ✅ FIXED: Don''t touch escrow
      v_pending_delta := 0;
      v_new_available := v_current_available + p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;')
WHERE proname = 'process_wallet_transaction';


COMMIT;
