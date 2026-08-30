-- =====================================================
-- Migration: 202
-- Partner wallet ACID RPCs
-- Makes partner withdrawals and partner credits atomic by moving the
-- balance update and the audit/withdrawal record into a single Postgres
-- transaction, and by adding a partner_wallet_ledger table for every
-- partner balance mutation.
-- =====================================================

BEGIN;

-- 1. Partner wallet ledger (audit trail for all balance mutations)
CREATE TABLE IF NOT EXISTS partner_wallet_ledger (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id        UUID REFERENCES verified_logistics_partners(id) ON DELETE CASCADE NOT NULL,
  wallet_id         UUID REFERENCES partner_wallets(id) NOT NULL,
  idempotency_key   VARCHAR(255) UNIQUE,
  transaction_type  VARCHAR(20) NOT NULL CHECK (transaction_type IN ('credit', 'withdrawal_hold', 'withdrawal_release', 'withdrawal_complete', 'adjustment')),
  amount            DECIMAL(18,2) NOT NULL,
  balance_after     DECIMAL(18,2) NOT NULL,
  reference_type    VARCHAR(50),
  reference_id      UUID,
  description       TEXT,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_partner_wallet_ledger_partner_id ON partner_wallet_ledger(partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_wallet_ledger_idempotency ON partner_wallet_ledger(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_partner_wallet_ledger_reference ON partner_wallet_ledger(reference_type, reference_id);

-- 2. RLS for new ledger table
ALTER TABLE partner_wallet_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY partner_wallet_ledger_service_all ON partner_wallet_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. Atomic partner withdrawal creation
CREATE OR REPLACE FUNCTION create_partner_withdrawal_atomic(
  p_partner_id UUID,
  p_bank_account_id UUID,
  p_amount NUMERIC,
  p_currency VARCHAR(3) DEFAULT 'NGN',
  p_reference VARCHAR(100) DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_idempotency_key VARCHAR(255) DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_bank_account RECORD;
  v_wallet       partner_wallets%ROWTYPE;
  v_withdrawal   partner_withdrawals%ROWTYPE;
  v_existing     partner_wallet_ledger%ROWTYPE;
  v_old          partner_withdrawals%ROWTYPE;
  v_new_balance  NUMERIC;
  v_new_pending  NUMERIC;
BEGIN
  -- Idempotency: if this key was already processed, return the original result.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM partner_wallet_ledger
    WHERE idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN
      SELECT * INTO v_old
      FROM partner_withdrawals
      WHERE id = v_existing.reference_id
      LIMIT 1;

      IF FOUND THEN
        SELECT * INTO v_wallet
        FROM partner_wallets
        WHERE id = v_existing.wallet_id;

        RETURN jsonb_build_object(
          'success', true,
          'withdrawal', to_jsonb(v_old),
          'wallet', to_jsonb(v_wallet),
          'message', 'Withdrawal already processed (idempotent)'
        );
      END IF;
    END IF;
  END IF;

  -- Validate amount.
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Withdrawal amount must be positive',
      'error_code', 'INVALID_AMOUNT'
    );
  END IF;

  -- Validate bank account belongs to partner and is active.
  SELECT * INTO v_bank_account
  FROM partner_bank_accounts
  WHERE id = p_bank_account_id
    AND partner_id = p_partner_id
    AND is_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Bank account not found or inactive',
      'error_code', 'BANK_ACCOUNT_INVALID'
    );
  END IF;

  -- Lock partner wallet row.
  SELECT * INTO v_wallet
  FROM partner_wallets
  WHERE partner_id = p_partner_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Partner wallet not found',
      'error_code', 'WALLET_NOT_FOUND'
    );
  END IF;

  IF v_wallet.available_balance < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Insufficient available balance',
      'error_code', 'INSUFFICIENT_FUNDS'
    );
  END IF;

  v_new_balance := COALESCE(v_wallet.available_balance, 0) - p_amount;
  v_new_pending := COALESCE(v_wallet.pending_withdrawal, 0) + p_amount;

  -- Insert withdrawal record.
  INSERT INTO partner_withdrawals (
    partner_id,
    wallet_id,
    bank_account_id,
    amount,
    currency,
    status,
    reference,
    notes,
    requested_at
  ) VALUES (
    p_partner_id,
    v_wallet.id,
    p_bank_account_id,
    p_amount,
    p_currency,
    'pending',
    p_reference,
    p_description,
    NOW()
  )
  RETURNING * INTO v_withdrawal;

  -- Update wallet balances.
  UPDATE partner_wallets
  SET
    available_balance = v_new_balance,
    pending_withdrawal = v_new_pending,
    updated_at = NOW()
  WHERE id = v_wallet.id
  RETURNING * INTO v_wallet;

  -- Insert ledger entry.
  INSERT INTO partner_wallet_ledger (
    partner_id,
    wallet_id,
    idempotency_key,
    transaction_type,
    amount,
    balance_after,
    reference_type,
    reference_id,
    description
  ) VALUES (
    p_partner_id,
    v_wallet.id,
    p_idempotency_key,
    'withdrawal_hold',
    -p_amount,
    v_new_balance,
    'withdrawal',
    v_withdrawal.id,
    COALESCE(p_description, 'Withdrawal hold')
  );

  RETURN jsonb_build_object(
    'success', true,
    'withdrawal', to_jsonb(v_withdrawal),
    'wallet', to_jsonb(v_wallet)
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Withdrawal creation failed: ' || SQLERRM,
      'error_code', 'INTERNAL_ERROR'
    );
END;
$$;

COMMENT ON FUNCTION create_partner_withdrawal_atomic IS
'Atomically creates a partner withdrawal: validates the bank account, locks the wallet, debits available balance, credits pending withdrawal, inserts the withdrawal request and a ledger row in one transaction.';

-- 4. Atomic partner wallet credit
CREATE OR REPLACE FUNCTION credit_partner_wallet_atomic(
  p_partner_id UUID,
  p_amount NUMERIC,
  p_description TEXT DEFAULT NULL,
  p_reference_type VARCHAR(50) DEFAULT 'credit',
  p_reference_id UUID DEFAULT NULL,
  p_idempotency_key VARCHAR(255) DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_wallet       partner_wallets%ROWTYPE;
  v_ledger       partner_wallet_ledger%ROWTYPE;
  v_existing     partner_wallet_ledger%ROWTYPE;
  v_new_balance  NUMERIC;
  v_new_earned   NUMERIC;
BEGIN
  -- Idempotency.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM partner_wallet_ledger
    WHERE idempotency_key = p_idempotency_key
    LIMIT 1;

    IF FOUND THEN
      SELECT * INTO v_wallet
      FROM partner_wallets
      WHERE id = v_existing.wallet_id;

      RETURN jsonb_build_object(
        'success', true,
        'ledger_id', v_existing.id,
        'wallet', to_jsonb(v_wallet),
        'message', 'Credit already processed (idempotent)'
      );
    END IF;
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Credit amount must be positive',
      'error_code', 'INVALID_AMOUNT'
    );
  END IF;

  SELECT * INTO v_wallet
  FROM partner_wallets
  WHERE partner_id = p_partner_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Partner wallet not found',
      'error_code', 'WALLET_NOT_FOUND'
    );
  END IF;

  v_new_balance := COALESCE(v_wallet.available_balance, 0) + p_amount;
  v_new_earned := COALESCE(v_wallet.total_earned, 0) + p_amount;

  UPDATE partner_wallets
  SET
    available_balance = v_new_balance,
    total_earned = v_new_earned,
    updated_at = NOW()
  WHERE id = v_wallet.id
  RETURNING * INTO v_wallet;

  INSERT INTO partner_wallet_ledger (
    partner_id,
    wallet_id,
    idempotency_key,
    transaction_type,
    amount,
    balance_after,
    reference_type,
    reference_id,
    description
  ) VALUES (
    p_partner_id,
    v_wallet.id,
    p_idempotency_key,
    'credit',
    p_amount,
    v_new_balance,
    p_reference_type,
    p_reference_id,
    p_description
  )
  RETURNING * INTO v_ledger;

  RETURN jsonb_build_object(
    'success', true,
    'ledger_id', v_ledger.id,
    'wallet', to_jsonb(v_wallet)
  );

EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Wallet credit failed: ' || SQLERRM,
      'error_code', 'INTERNAL_ERROR'
    );
END;
$$;

COMMENT ON FUNCTION credit_partner_wallet_atomic IS
'Atomically credits a partner wallet: locks the row, increments available_balance and total_earned, and inserts a partner_wallet_ledger audit row in one transaction.';

-- 5. Permissions (service role only)
REVOKE ALL ON FUNCTION create_partner_withdrawal_atomic(UUID, UUID, NUMERIC, VARCHAR, VARCHAR, TEXT, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION create_partner_withdrawal_atomic(UUID, UUID, NUMERIC, VARCHAR, VARCHAR, TEXT, VARCHAR) FROM anon;
REVOKE ALL ON FUNCTION create_partner_withdrawal_atomic(UUID, UUID, NUMERIC, VARCHAR, VARCHAR, TEXT, VARCHAR) FROM authenticated;
GRANT EXECUTE ON FUNCTION create_partner_withdrawal_atomic(UUID, UUID, NUMERIC, VARCHAR, VARCHAR, TEXT, VARCHAR) TO service_role;
ALTER FUNCTION create_partner_withdrawal_atomic(UUID, UUID, NUMERIC, VARCHAR, VARCHAR, TEXT, VARCHAR) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION credit_partner_wallet_atomic(UUID, NUMERIC, TEXT, VARCHAR, UUID, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION credit_partner_wallet_atomic(UUID, NUMERIC, TEXT, VARCHAR, UUID, VARCHAR) FROM anon;
REVOKE ALL ON FUNCTION credit_partner_wallet_atomic(UUID, NUMERIC, TEXT, VARCHAR, UUID, VARCHAR) FROM authenticated;
GRANT EXECUTE ON FUNCTION credit_partner_wallet_atomic(UUID, NUMERIC, TEXT, VARCHAR, UUID, VARCHAR) TO service_role;
ALTER FUNCTION credit_partner_wallet_atomic(UUID, NUMERIC, TEXT, VARCHAR, UUID, VARCHAR) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
-- select has_function_privilege('service_role', 'create_partner_withdrawal_atomic(uuid,uuid,numeric,varchar,varchar,text,varchar)', 'EXECUTE') as can_create_wd,
--        has_function_privilege('service_role', 'credit_partner_wallet_atomic(uuid,numeric,text,varchar,uuid,varchar)', 'EXECUTE') as can_credit;
--
-- Expected: can_create_wd = true, can_credit = true; authenticated/anon = false.
-- =====================================================
