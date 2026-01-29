-- Migration: Fix ESCROW_REFUND transaction logic
-- Description: Fixes the ESCROW_REFUND transaction to properly move funds FROM escrow TO available balance
-- Bug: ESCROW_REFUND was incorrectly adding funds to both escrow and available instead of moving from escrow to available
-- Impact: Users cancelling orders (both buyer and vendor) were not receiving proper refunds
-- Version: 157

-- Drop and recreate the process_wallet_transaction function with corrected ESCROW_REFUND logic
DROP FUNCTION IF EXISTS process_wallet_transaction(p_user_id UUID, p_transaction_type TEXT, p_amount NUMERIC, p_description TEXT, p_reference_id TEXT, p_reference_type TEXT);

CREATE OR REPLACE FUNCTION process_wallet_transaction(
  p_user_id UUID,
  p_transaction_type TEXT,
  p_amount NUMERIC,
  p_description TEXT,
  p_reference_id TEXT DEFAULT NULL,
  p_reference_type TEXT DEFAULT NULL
)
RETURNS TABLE(
  success BOOLEAN,
  transaction_id UUID,
  new_available_balance NUMERIC,
  new_escrow_balance NUMERIC,
  new_pending_withdrawal NUMERIC,
  error_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  -- Wallet balance variables
  v_current_available NUMERIC;
  v_current_escrow NUMERIC;
  v_current_pending NUMERIC;
  v_new_available NUMERIC;
  v_new_escrow NUMERIC;
  v_new_pending NUMERIC;
  
  -- Transaction delta variables
  v_available_delta NUMERIC;
  v_escrow_delta NUMERIC;
  v_pending_delta NUMERIC;
  
  -- Sales tracking variables
  v_current_vendor_sales NUMERIC DEFAULT 0;
  v_current_rider_earnings NUMERIC DEFAULT 0;
  v_current_lifetime_revenue NUMERIC DEFAULT 0;
  v_new_vendor_sales NUMERIC;
  v_new_rider_earnings NUMERIC;
  v_new_lifetime_revenue NUMERIC;
  
  -- Transaction record
  v_transaction_id UUID;
  v_wallet_id UUID;
  
  -- Idempotency check
  v_existing_id UUID;
BEGIN
  -- Get user's wallet
  SELECT id, available_balance, escrow_balance, pending_withdrawal, 
         total_vendor_sales, total_rider_earnings, lifetime_revenue
  INTO v_wallet_id, v_current_available, v_current_escrow, v_current_pending,
       v_current_vendor_sales, v_current_rider_earnings, v_current_lifetime_revenue
  FROM wallets
  WHERE user_id = p_user_id
  FOR UPDATE; -- Lock the wallet row for atomic operation

  -- Check if wallet exists
  IF v_wallet_id IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL, 0, 0, 0, 'Wallet not found for user';
    RETURN;
  END IF;

  -- Idempotency check: prevent duplicate transactions
  SELECT id INTO v_existing_id
  FROM wallet_ledger
  WHERE user_id = p_user_id
    AND transaction_type = p_transaction_type
    AND amount = p_amount
    AND reference_id = p_reference_id
    AND reference_type = p_reference_type
    AND created_at > NOW() - INTERVAL '1 hour'
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    -- Return existing transaction details
    SELECT available_balance, escrow_balance, pending_withdrawal
    INTO v_current_available, v_current_escrow, v_current_pending
    FROM wallets
    WHERE user_id = p_user_id;
    
    RETURN QUERY SELECT TRUE, v_existing_id, v_current_available, v_current_escrow, v_current_pending, 'Idempotent: transaction already processed';
    RETURN;
  END IF;

  -- Initialize sales tracking variables
  v_new_vendor_sales := v_current_vendor_sales;
  v_new_rider_earnings := v_current_rider_earnings;
  v_new_lifetime_revenue := v_current_lifetime_revenue;

  -- 2. Calculate deltas based on transaction type
  CASE p_transaction_type
    -- ✅ VENDOR SALE: Credit available + track as vendor sale
    WHEN 'escrow_release' THEN
      v_available_delta := p_amount;
      v_new_available := v_current_available + p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;
      
      -- Track as vendor sale
      v_new_vendor_sales := v_current_vendor_sales + p_amount;
      v_new_lifetime_revenue := v_current_lifetime_revenue + p_amount;

    -- ✅ RIDER DELIVERY FEE: Credit available + track as rider earnings
    WHEN 'delivery_payment' THEN
      v_available_delta := p_amount;
      v_new_available := v_current_available + p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;
      
      -- Track as rider earnings
      v_new_rider_earnings := v_current_rider_earnings + p_amount;
      v_new_lifetime_revenue := v_current_lifetime_revenue + p_amount;

    -- Other transaction types (deposit, withdrawal, etc.)
    WHEN 'deposit_mint', 'reward_credit', 'admin_adjustment' THEN
      v_available_delta := p_amount;
      v_new_available := v_current_available + p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    -- ✅ CRITICAL FIX: Correct purchase_hold logic
    WHEN 'purchase_hold' THEN
      v_available_delta := -p_amount;    -- ✅ FIXED: Debit from available (negative)
      v_escrow_delta := p_amount;        -- ✅ FIXED: Credit to escrow (positive)
      v_new_available := v_current_available - p_amount;
      v_new_escrow := v_current_escrow + p_amount;
      v_new_pending := v_current_pending;

    -- ✅ CRITICAL FIX: Correct escrow_refund logic
    WHEN 'escrow_refund' THEN
      v_escrow_delta := -p_amount;       -- ✅ FIXED: Debit from escrow (negative)
      v_available_delta := ABS(p_amount); -- ✅ FIXED: Credit to available (positive)
      v_new_escrow := v_current_escrow - p_amount;
      v_new_available := v_current_available + ABS(p_amount);
      v_new_pending := v_current_pending;

    -- Withdrawal and fee transactions
    WHEN 'withdrawal_burn', 'fee_deduction' THEN
      v_available_delta := -p_amount;
      v_new_available := v_current_available - p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending;

    -- Withdrawal request (move to pending)
    WHEN 'withdrawal_request' THEN
      v_available_delta := -p_amount;
      v_pending_delta := p_amount;
      v_new_available := v_current_available - p_amount;
      v_new_escrow := v_current_escrow;
      v_new_pending := v_current_pending + p_amount;

    -- Platform commission (debit from escrow)
    WHEN 'platform_commission' THEN
      v_escrow_delta := -p_amount;
      v_new_available := v_current_available;
      v_new_escrow := v_current_escrow - p_amount;
      v_new_pending := v_current_pending;

    ELSE
      -- Unknown transaction type
      RETURN QUERY SELECT FALSE, NULL, v_current_available, v_current_escrow, v_current_pending, 
                     'Unknown transaction type: ' || p_transaction_type;
      RETURN;
  END CASE;

  -- 3. Validate sufficient balance for debit operations
  IF p_transaction_type IN ('purchase_hold', 'withdrawal_burn', 'fee_deduction', 'withdrawal_request') THEN
    IF v_current_available < ABS(v_available_delta) THEN
      RETURN QUERY SELECT FALSE, NULL, v_current_available, v_current_escrow, v_current_pending, 
                     'Insufficient available balance';
      RETURN;
    END IF;
  END IF;

  IF p_transaction_type = 'escrow_refund' THEN
    IF v_current_escrow < ABS(v_escrow_delta) THEN
      RETURN QUERY SELECT FALSE, NULL, v_current_available, v_current_escrow, v_current_pending, 
                     'Insufficient escrow balance';
      RETURN;
    END IF;
  END IF;

  IF p_transaction_type = 'platform_commission' THEN
    IF v_current_escrow < ABS(v_escrow_delta) THEN
      RETURN QUERY SELECT FALSE, NULL, v_current_available, v_current_escrow, v_current_pending, 
                     'Insufficient escrow balance for commission';
      RETURN;
    END IF;
  END IF;

  -- 4. Update wallet balances
  UPDATE wallets
  SET 
    available_balance = v_new_available,
    escrow_balance = v_new_escrow,
    pending_withdrawal = v_new_pending,
    total_vendor_sales = v_new_vendor_sales,
    total_rider_earnings = v_new_rider_earnings,
    lifetime_revenue = v_new_lifetime_revenue,
    updated_at = NOW()
  WHERE id = v_wallet_id;

  -- 5. Create transaction record
  INSERT INTO wallet_ledger (
    user_id,
    wallet_id,
    transaction_type,
    amount,
    description,
    reference_id,
    reference_type,
    balance_before,
    balance_after,
    escrow_balance_before,
    escrow_balance_after,
    pending_balance_before,
    pending_balance_after
  )
  VALUES (
    p_user_id,
    v_wallet_id,
    p_transaction_type,
    p_amount,
    p_description,
    p_reference_id,
    p_reference_type,
    v_current_available,
    v_new_available,
    v_current_escrow,
    v_new_escrow,
    v_current_pending,
    v_new_pending
  )
  RETURNING id INTO v_transaction_id;

  -- 6. Create sales ledger entry for vendor sales
  IF p_transaction_type = 'escrow_release' THEN
    INSERT INTO sales_ledger (
      vendor_id,
      order_id,
      amount,
      commission_rate,
      commission_amount,
      net_amount,
      status,
      created_at
    )
    VALUES (
      p_user_id,
      p_reference_id,
      p_amount,
      0.02, -- 2% platform commission
      p_amount * 0.02,
      p_amount * 0.98,
      'completed',
      NOW()
    );
  END IF;

  -- 7. Return success
  RETURN QUERY SELECT TRUE, v_transaction_id, v_new_available, v_new_escrow, v_new_pending, NULL::TEXT;

EXCEPTION
  WHEN OTHERS THEN
    -- Log error and return failure
    RETURN QUERY SELECT FALSE, NULL, v_current_available, v_current_escrow, v_current_pending, 
                   SQLERRM::TEXT;
END;
$$;

-- Add comment explaining the fix
COMMENT ON FUNCTION process_wallet_transaction IS 'Fixed ESCROW_REFUND logic to properly move funds FROM escrow TO available balance (migration 157)';
