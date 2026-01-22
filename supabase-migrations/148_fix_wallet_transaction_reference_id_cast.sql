BEGIN;

-- =====================================================
-- FIX WALLET TRANSACTION REFERENCE_ID CAST
-- Migration: 148
-- Date: 2026-01-20
-- Description: Fix reference_id casting from TEXT to UUID in process_wallet_transaction
-- =====================================================

DROP FUNCTION IF EXISTS process_wallet_transaction(UUID, TEXT, DECIMAL, TEXT, TEXT, TEXT);

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
  v_available_delta DECIMAL;
  v_escrow_delta DECIMAL;
  v_pending_delta DECIMAL;
  v_transaction_id UUID;
  v_new_vendor_sales DECIMAL;
  v_new_rider_earnings DECIMAL;
  v_new_lifetime_revenue DECIMAL;
  v_reference_id_uuid UUID;
BEGIN
  -- Validate reference_id: convert TEXT to UUID if valid, otherwise NULL
  IF p_reference_id IS NULL OR p_reference_id = '' THEN
    v_reference_id_uuid := NULL;
  ELSIF p_reference_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    -- Valid UUID format, cast to UUID
    v_reference_id_uuid := p_reference_id::UUID;
  ELSE
    -- Invalid UUID format, set to NULL
    v_reference_id_uuid := NULL;
  END IF;

  -- 1. Get or create wallet
  SELECT id INTO v_wallet_id
  FROM wallets
  WHERE user_id = p_user_id;

  IF v_wallet_id IS NULL THEN
    INSERT INTO wallets (user_id, available_balance, escrow_balance, pending_withdrawal, preferred_currency, kyc_status)
    VALUES (p_user_id, 0, 0, 0, 'USD', 'pending')
    RETURNING id INTO v_wallet_id;
  END IF;

  -- 2. Get current balances (with row-level lock)
  SELECT available_balance, escrow_balance, pending_withdrawal,
         total_vendor_sales, total_rider_earnings, lifetime_revenue
  INTO v_current_available, v_current_escrow, v_current_pending,
       v_new_vendor_sales, v_new_rider_earnings, v_new_lifetime_revenue
  FROM wallets
  WHERE id = v_wallet_id
  FOR UPDATE;

  -- 3. Calculate new balances based on transaction type
  v_available_delta := 0;
  v_escrow_delta := 0;
  v_pending_delta := 0;

  CASE p_transaction_type
    WHEN 'deposit_mint' THEN
      v_available_delta := p_amount;
    WHEN 'withdrawal_burn' THEN
      v_available_delta := p_amount; -- negative amount
    WHEN 'purchase_hold' THEN
      v_available_delta := p_amount; -- negative amount
      v_escrow_delta := ABS(p_amount);
    WHEN 'escrow_release' THEN
      v_escrow_delta := p_amount; -- negative (debit escrow)
      v_available_delta := ABS(p_amount); -- credit available
    WHEN 'escrow_refund' THEN
      v_escrow_delta := p_amount; -- negative (debit escrow)
      v_available_delta := ABS(p_amount); -- credit available
    WHEN 'admin_adjustment' THEN
      v_available_delta := p_amount;
    WHEN 'fee_deduction' THEN
      v_available_delta := p_amount; -- negative amount
    WHEN 'reward_credit' THEN
      v_available_delta := p_amount;
    WHEN 'delivery_payment' THEN
      v_available_delta := p_amount; -- negative amount
    WHEN 'platform_commission' THEN
      v_available_delta := p_amount;
    WHEN 'withdrawal_request' THEN
      v_available_delta := p_amount; -- negative amount
      v_pending_delta := ABS(p_amount);
    WHEN 'escrow_release_to_platform' THEN
      v_escrow_delta := p_amount; -- negative (debit escrow)
    WHEN 'gift_purchase' THEN
      v_available_delta := p_amount; -- negative amount (debit)
    WHEN 'gift_conversion' THEN
      v_available_delta := p_amount; -- can be positive (credit) or negative (debit)
    ELSE
      RAISE EXCEPTION 'Invalid transaction type: %', p_transaction_type;
  END CASE;

  v_new_available := v_current_available + v_available_delta;
  v_new_escrow := v_current_escrow + v_escrow_delta;
  v_new_pending := v_current_pending + v_pending_delta;

  -- Validate balances
  IF v_new_available < 0 THEN
    RAISE EXCEPTION 'Insufficient available balance. Current: %, Required: %', v_current_available, ABS(v_available_delta);
  END IF;
  IF v_new_escrow < 0 THEN
    RAISE EXCEPTION 'Insufficient escrow balance. Current: %, Required: %', v_current_escrow, ABS(v_escrow_delta);
  END IF;
  IF v_new_pending < 0 THEN
    RAISE EXCEPTION 'Invalid pending withdrawal balance. Current: %, Delta: %', v_current_pending, v_pending_delta;
  END IF;

  -- 4. Update wallet balances
  UPDATE wallets
  SET available_balance = v_new_available,
      escrow_balance = v_new_escrow,
      pending_withdrawal = v_new_pending,
      total_vendor_sales = v_new_vendor_sales,
      total_rider_earnings = v_new_rider_earnings,
      lifetime_revenue = v_new_lifetime_revenue,
      updated_at = NOW()
  WHERE id = v_wallet_id;

  -- 5. Create wallet ledger entry
  INSERT INTO wallet_ledger (
    id, wallet_id, user_id, transaction_type,
    available_delta, escrow_delta, pending_withdrawal_delta,
    available_balance_after, escrow_balance_after, pending_withdrawal_after,
    reference_type, reference_id, description, created_at, created_by
  ) VALUES (
    gen_random_uuid(), v_wallet_id, p_user_id, p_transaction_type,
    v_available_delta, v_escrow_delta, v_pending_delta,
    v_new_available, v_new_escrow, v_new_pending,
    p_reference_type, v_reference_id_uuid, p_description, NOW(), p_user_id
  )
  RETURNING id INTO v_transaction_id;

  -- 6. Create sales ledger entry (if applicable - only for escrow_release and delivery_payment)
  -- Note: sales_ledger.transaction_type must be 'vendor_sale' or 'rider_delivery', not 'escrow_release' or 'delivery_payment'
  IF p_transaction_type IN ('escrow_release', 'delivery_payment') THEN
    INSERT INTO sales_ledger (
      id, user_id, wallet_id, transaction_type, amount,
      order_id, escrow_id,
      vendor_sales_after, rider_earnings_after, lifetime_revenue_after,
      description, created_at, created_by
    ) VALUES (
      gen_random_uuid(), p_user_id, v_wallet_id, 
      CASE WHEN p_transaction_type = 'escrow_release' THEN 'vendor_sale' ELSE 'rider_delivery' END,
      ABS(p_amount),
      CASE WHEN p_reference_type = 'order' THEN v_reference_id_uuid ELSE NULL END,
      CASE WHEN p_reference_type = 'escrow' THEN v_reference_id_uuid ELSE NULL END,
      v_new_vendor_sales,
      v_new_rider_earnings,
      v_new_lifetime_revenue,
      p_description,
      NOW(),
      p_user_id
    );
  END IF;

  -- 7. Return transaction details
  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'wallet_id', v_wallet_id,
    'available_balance_after', v_new_available,
    'escrow_balance_after', v_new_escrow,
    'pending_withdrawal_after', v_new_pending
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', SQLERRM
    );
END;
$$;

COMMIT;

