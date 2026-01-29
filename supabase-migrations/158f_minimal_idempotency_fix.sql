-- =====================================================
-- IDEMPOTENCY FIX: Add Advisory Lock Protection Only
-- Migration: 158f
-- Date: 2026-01-28
-- Description: Add only the missing advisory lock protection to prevent race conditions
-- This is a minimal fix - only adds what was missing from 158e
-- =====================================================

-- Add advisory lock variable declaration to existing function
ALTER FUNCTION process_wallet_transaction(p_user_id UUID, p_transaction_type TEXT, p_amount NUMERIC, p_description TEXT, p_reference_id TEXT, p_reference_type TEXT)
ADD COLUMN v_lock_key BIGINT;

-- Add advisory lock logic after wallet exists check
DO $$
BEGIN
  -- Get the current function source
  SELECT prosrc INTO current_source FROM pg_proc WHERE proname = 'process_wallet_transaction';
  
  -- Insert advisory lock logic after wallet exists check
  new_source := replace(current_source,
    '  -- Check if wallet exists
  IF v_wallet_id IS NULL THEN',
    '  -- ✅ CRITICAL FIX: Add advisory lock protection (prevents race conditions and double charges)
  IF p_reference_id IS NOT NULL AND p_reference_id != '''' AND p_reference_type IS NOT NULL THEN
    v_lock_key := abs(hashtext(p_user_id::TEXT || p_transaction_type || p_reference_type || p_reference_id));
    PERFORM pg_advisory_xact_lock(v_lock_key);
  END IF;
  
  -- Check if wallet exists
  IF v_wallet_id IS NULL THEN');
  
  -- Update the function
  EXECUTE format('CREATE OR REPLACE FUNCTION process_wallet_transaction(%s) RETURNS %s AS %s LANGUAGE plpgsql SECURITY DEFINER', 
                 pronargs, prorettype::regtype, new_source);
END $$;

COMMIT;
