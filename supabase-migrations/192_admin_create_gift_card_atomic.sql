-- =====================================================
-- Migration: 192
-- Add admin_create_gift_card_atomic(): a single RPC that atomically debits
-- the platform wallet, credits the marketing/reserve wallet, inserts the
-- gift_cards row, and logs the admin_adjust audit entry.
--
-- Background (the bug this fixes):
--   GiftCardsService.adminCreateGiftCard() currently does a platform debit,
--   a reserve credit, then (if the reserve credit fails) a manual rollback
--   debit, then finally inserts the gift_cards row and logs the audit row.
--   If the gift_cards insert or log fails after the reserve was credited, the
--   platform is out the money but no card exists, or the card exists with no
--   audit log.
--
-- What this migration does:
--   admin_create_gift_card_atomic() performs the platform debit, reserve
--   credit, gift_cards insert, and gift_card_transactions audit log in one
--   Postgres transaction. A failure anywhere rolls the money back. This
--   guarantees every admin-created card is fully funded and audited.
--
--   This is additive-only: it only creates one new function.
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION admin_create_gift_card_atomic(
  p_design_id UUID,
  p_initial_balance NUMERIC,
  p_admin_id UUID,
  p_creation_reason TEXT,
  p_is_commercial BOOLEAN,
  p_notes TEXT,
  p_expires_at TIMESTAMPTZ,
  p_platform_wallet_id UUID,
  p_reserve_wallet_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_issuance_reference UUID := gen_random_uuid();
  v_amount DECIMAL(18,6);
  v_debit_result RECORD;
  v_credit_result RECORD;
  v_new_gift_card RECORD;
  v_metadata JSONB;
  v_gift_card_metadata JSONB;
BEGIN
  -- 1. Validate amount.
  IF p_initial_balance IS NULL OR p_initial_balance <= 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Initial balance must be positive',
      'error_code', 'INVALID_AMOUNT'
    );
  END IF;

  v_amount := ROUND(p_initial_balance::NUMERIC, 6);

  -- 2. Debit platform wallet.
  SELECT * INTO v_debit_result
  FROM process_wallet_transaction(
    p_platform_wallet_id,
    'GIFT_CARD_PURCHASE',
    -v_amount,
    format('Admin gift card: %s', p_creation_reason),
    v_issuance_reference::TEXT,
    'admin_gift_card'
  );

  IF NOT v_debit_result.success THEN
    RAISE EXCEPTION 'Failed to debit platform wallet for admin gift card: %', v_debit_result.error_message;
  END IF;

  -- 3. Credit marketing/reserve wallet.
  SELECT * INTO v_credit_result
  FROM process_wallet_transaction(
    p_reserve_wallet_id,
    'GIFT_CARD_PURCHASE',
    v_amount,
    format('Admin gift card reserve funding: %s', p_creation_reason),
    v_issuance_reference::TEXT,
    'admin_gift_card'
  );

  IF NOT v_credit_result.success THEN
    RAISE EXCEPTION 'Failed to credit reserve wallet for admin gift card: %', v_credit_result.error_message;
  END IF;

  -- 4. Insert the gift_cards row.
  v_gift_card_metadata := jsonb_build_object(
    'notes', p_notes,
    'admin_created', true,
    'platform_debit_transaction_id', v_debit_result.transaction_id,
    'reserve_credit_transaction_id', v_credit_result.transaction_id
  );

  INSERT INTO gift_cards (
    design_id,
    initial_balance,
    current_balance,
    status,
    purchaser_id,
    delivery_method,
    expires_at,
    created_by,
    source,
    creation_reason,
    is_commercial,
    metadata,
    created_at,
    updated_at
  )
  VALUES (
    p_design_id,
    v_amount,
    v_amount,
    'active',
    NULL,
    'none',
    p_expires_at,
    p_admin_id,
    'admin_created',
    p_creation_reason,
    COALESCE(p_is_commercial, false),
    v_gift_card_metadata,
    NOW(),
    NOW()
  )
  RETURNING *
  INTO v_new_gift_card;

  -- 5. Log creation audit transaction.
  v_metadata := jsonb_build_object(
    'action', 'admin_creation',
    'reason', p_creation_reason,
    'is_commercial', COALESCE(p_is_commercial, false),
    'notes', p_notes,
    'admin_id', p_admin_id
  );

  INSERT INTO gift_card_transactions (
    gift_card_id,
    transaction_type,
    amount,
    balance_after,
    user_id,
    metadata,
    created_at,
    updated_at
  )
  VALUES (
    v_new_gift_card.id,
    'admin_adjust',
    v_amount,
    v_amount,
    NULL,
    v_metadata,
    NOW(),
    NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'gift_card', to_jsonb(v_new_gift_card),
    'platform_debit_transaction_id', v_debit_result.transaction_id,
    'reserve_credit_transaction_id', v_credit_result.transaction_id
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error in admin_create_gift_card_atomic: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during admin gift card creation',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION admin_create_gift_card_atomic IS
'Atomically creates an admin-issued gift card: debits the platform wallet, credits the reserve wallet, inserts the gift_cards row, and logs an admin_adjust audit row in a single Postgres transaction.';

REVOKE ALL ON FUNCTION admin_create_gift_card_atomic(UUID, NUMERIC, UUID, TEXT, BOOLEAN, TEXT, TIMESTAMPTZ, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_create_gift_card_atomic(UUID, NUMERIC, UUID, TEXT, BOOLEAN, TEXT, TIMESTAMPTZ, UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION admin_create_gift_card_atomic(UUID, NUMERIC, UUID, TEXT, BOOLEAN, TEXT, TIMESTAMPTZ, UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION admin_create_gift_card_atomic(UUID, NUMERIC, UUID, TEXT, BOOLEAN, TEXT, TIMESTAMPTZ, UUID, UUID) TO service_role;
ALTER FUNCTION admin_create_gift_card_atomic(UUID, NUMERIC, UUID, TEXT, BOOLEAN, TEXT, TIMESTAMPTZ, UUID, UUID) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'admin_create_gift_card_atomic(uuid,numeric,uuid,text,boolean,text,timestamptz,uuid,uuid)', 'EXECUTE') as create_ok,
--        has_function_privilege('authenticated', 'admin_create_gift_card_atomic(uuid,numeric,uuid,text,boolean,text,timestamptz,uuid,uuid)', 'EXECUTE') as create_auth_ok;
--
-- Expected: create_ok = true, create_auth_ok = false.
--
-- Next step: replace the per-card multi-call loop in
-- GiftCardsService.adminCreateGiftCard() with a single RPC call per card.
-- =====================================================
