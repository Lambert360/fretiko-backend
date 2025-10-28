-- =====================================================
-- FIX PROCESS_WALLET_TRANSACTION UUID CASTING
-- =====================================================
-- This migration fixes the UUID casting issue in the process_wallet_transaction RPC function
-- The reference_id parameter is TEXT but needs to be cast to UUID for the wallet_ledger table

-- Update the function to properly cast TEXT to UUID
CREATE OR REPLACE FUNCTION process_wallet_transaction(
  p_user_id UUID,
  p_transaction_type TEXT,
  p_amount DECIMAL,
  p_description TEXT,
  p_reference_id TEXT DEFAULT NULL,
  p_reference_type TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_wallet_id UUID;
  v_current_available DECIMAL;
  v_current_escrow DECIMAL;
  v_current_pending DECIMAL;
  v_new_available DECIMAL;
  v_new_escrow DECIMAL;
  v_new_pending DECIMAL;
  v_transaction_id UUID;
  v_available_delta DECIMAL := 0;
  v_escrow_delta DECIMAL := 0;
  v_pending_delta DECIMAL := 0;
BEGIN
  -- 1. Get wallet and current balances
  SELECT id, available_balance, escrow_balance, pending_withdrawal
  INTO v_wallet_id, v_current_available, v_current_escrow, v_current_pending
  FROM wallets
  WHERE user_id = p_user_id
  FOR UPDATE; -- Lock the row to prevent race conditions

  -- If wallet doesn't exist, create it
  IF v_wallet_id IS NULL THEN
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
      p_user_id,
      0.0,
      0.0,
      0.0,
      'USD',
      'pending',
      10000.0,
      5000.0,
      NOW(),
      NOW()
    )
    RETURNING id, available_balance, escrow_balance, pending_withdrawal
    INTO v_wallet_id, v_current_available, v_current_escrow, v_current_pending;
  END IF;

  -- 2. Calculate deltas based on transaction type
  CASE p_transaction_type
    -- Credits to available balance
    WHEN 'deposit_mint', 'escrow_release', 'escrow_refund', 'reward_credit', 'admin_adjustment', 'delivery_payment', 'vendor_sale' THEN
      v_available_delta := p_amount;
      v_new_available := v_current_available + p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    -- Debit from available, add to escrow (purchase hold)
    WHEN 'purchase_hold' THEN
      v_available_delta := -p_amount;
      v_escrow_delta := p_amount;
      v_new_available := v_current_available - p_amount;
      v_new_escrow := v_current_escrow + p_amount;
      v_new_pending := v_current_pending;

    -- Debit from available balance (withdrawal, fee)
    WHEN 'withdrawal_burn', 'fee_deduction' THEN
      v_available_delta := -p_amount;
      v_new_available := v_current_available - p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    -- Debit from available, add to pending withdrawal
    WHEN 'withdrawal_request' THEN
      v_available_delta := -p_amount;
      v_pending_delta := p_amount;
      v_new_available := v_current_available - p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending + p_amount;

    -- Debit from escrow (escrow release already handled above)
    WHEN 'escrow_release_to_platform' THEN
      v_escrow_delta := -p_amount;
      v_new_available := v_current_available;
      v_new_escrow := v_current_escrow - p_amount;
      v_new_pending := v_current_pending;

    ELSE
      RAISE EXCEPTION 'Unknown transaction type: %', p_transaction_type;
  END CASE;

  -- 3. Validate balances (no negative balances)
  IF v_new_available < 0 THEN
    RAISE EXCEPTION 'Insufficient available balance: % required, % available', p_amount, v_current_available;
  END IF;

  IF v_new_escrow < 0 THEN
    RAISE EXCEPTION 'Insufficient escrow balance';
  END IF;

  IF v_new_pending < 0 THEN
    RAISE EXCEPTION 'Insufficient pending withdrawal balance';
  END IF;

  -- 4. Update wallet balances
  UPDATE wallets
  SET
    available_balance = v_new_available,
    escrow_balance = v_new_escrow,
    pending_withdrawal = v_new_pending,
    updated_at = NOW()
  WHERE id = v_wallet_id;

  -- 5. Create ledger entry with proper UUID casting
  INSERT INTO wallet_ledger (
    id,
    wallet_id,
    user_id,
    transaction_type,
    available_delta,
    escrow_delta,
    pending_withdrawal_delta,
    available_balance_after,
    escrow_balance_after,
    pending_withdrawal_after,
    reference_type,
    reference_id,
    description,
    created_at,
    created_by
  ) VALUES (
    gen_random_uuid(),
    v_wallet_id,
    p_user_id,
    p_transaction_type,
    v_available_delta,
    v_escrow_delta,
    v_pending_delta,
    v_new_available,
    v_new_escrow,
    v_new_pending,
    p_reference_type,
    CASE 
      WHEN p_reference_id IS NOT NULL THEN p_reference_id::UUID 
      ELSE NULL 
    END, -- Properly cast TEXT to UUID or NULL
    p_description,
    NOW(),
    p_user_id
  )
  RETURNING id INTO v_transaction_id;

  -- 6. Return transaction details
  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'wallet_id', v_wallet_id,
    'previous_available', v_current_available,
    'new_available', v_new_available,
    'previous_escrow', v_current_escrow,
    'new_escrow', v_new_escrow,
    'previous_pending', v_current_pending,
    'new_pending', v_new_pending,
    'available_delta', v_available_delta,
    'escrow_delta', v_escrow_delta,
    'pending_delta', v_pending_delta
  );

EXCEPTION
  WHEN OTHERS THEN
    -- Log error and return failure
    RAISE WARNING 'process_wallet_transaction failed: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION process_wallet_transaction(UUID, TEXT, DECIMAL, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION process_wallet_transaction(UUID, TEXT, DECIMAL, TEXT, TEXT, TEXT) TO service_role;

-- Add comment
COMMENT ON FUNCTION process_wallet_transaction IS 'Atomically process wallet transactions with balance updates and ledger entries - FIXED UUID casting';

-- =====================================================
-- VERIFICATION
-- =====================================================
-- Test the function (optional - comment out if not needed)
-- SELECT process_wallet_transaction(
--   p_user_id := 'your-user-id-here'::UUID,
--   p_transaction_type := 'admin_adjustment',
--   p_amount := 100.00,
--   p_description := 'Test credit',
--   p_reference_id := 'your-order-id-here',
--   p_reference_type := 'order'
-- );
