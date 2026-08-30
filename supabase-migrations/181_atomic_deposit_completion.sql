-- =====================================================
-- Migration: 181
-- Add complete_deposit_credit(): a single atomic RPC that
-- credits a user's wallet for a completed Flutterwave deposit
-- and transitions the deposit row to 'completed' in one
-- Postgres transaction.
--
-- Background (two bugs this fixes):
--   1. Ordering bug (same as withdrawal):
--      handleDepositWebhook() on 'charge.completed' / 'successful'
--      does:
--        a. UPDATE deposits SET status = 'completed' ...
--        b. createLedgerEntry(...) -> RPC atomic_wallet_operation
--           (credits available_balance with 'deposit_mint')
--      These are separate network round-trips. If the ledger
--      credit fails after the status update, the deposit is
--      stuck as completed with no money credited (a retry
--      sees 'completed' and returns early via the existing
--      idempotency guard, so the missing credit can never be
--      applied).
--
--   2. Unstable idempotency key (double-credit risk):
--      The current code builds the key as
--      `deposit_${txRef}_${Date.now()}`.
--      `Date.now()` is different on every webhook/retry, so
--      concurrent or repeated webhooks for the same deposit
--      will generate different idempotency keys. Both can pass
--      the pre-check `IF deposit.status <> 'completed'` and
--      both call createLedgerEntry, resulting in two
--      'deposit_mint' ledger rows and a double-credited wallet.
--      atomic_wallet_operation's idempotency only protects
--      against the *same key*; a different key is a different
--      transaction.
--
-- What this migration does:
--   Adds complete_deposit_credit(), which:
--     1. Locks the deposits row FOR UPDATE.
--     2. Returns already_processed if status is 'completed'.
--     3. Builds a stable idempotency key from
--        'deposit_mint_<deposit_id>_<external_payment_id>'
--        so the same Flutterwave payment can be retried or
--        delivered concurrently without ever producing two
--        ledger entries.
--     4. Calls atomic_wallet_operation() to credit the wallet
--        (deposit_mint) before updating deposits.status.
--     5. Only after the ledger call succeeds, marks the deposit
--        'completed' and stores the final amount, exchange rate,
--        and webhook data.
--     All in one transaction, so a ledger failure rolls back
--     the deposit status update and leaves the deposit ready
--     for a correct retry.
--
--   Like 180, this is purely additive and does not alter the
--   existing deposits table or atomic_wallet_operation.
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION complete_deposit_credit(
  p_deposit_id UUID,
  p_freti_amount NUMERIC,
  p_external_payment_id TEXT DEFAULT NULL,
  p_exchange_rate NUMERIC DEFAULT NULL,
  p_local_amount NUMERIC DEFAULT NULL,
  p_local_currency TEXT DEFAULT NULL,
  p_webhook_data JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deposit RECORD;
  v_idempotency_key TEXT;
  v_ledger_result RECORD;
BEGIN
  -- 1. Lock the deposit row for the duration of this transaction.
  SELECT * INTO v_deposit
  FROM deposits
  WHERE id = p_deposit_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Deposit not found',
      'error_code', 'DEPOSIT_NOT_FOUND'
    );
  END IF;

  -- 2. Idempotency / terminal-state guard.
  IF v_deposit.status = 'completed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'deposit_status', v_deposit.status
    );
  END IF;

  -- 3. Stable idempotency key. This is the fix for the
  --    Date.now() key problem: the same Flutterwave payment
  --    (identified by deposit_id + external_payment_id) always
  --    produces the same key, so concurrent/retried webhooks
  --    cannot double-credit.
  v_idempotency_key := 'deposit_mint_' || v_deposit.id || '_' || COALESCE(p_external_payment_id, 'unknown');

  -- 4. Credit the wallet. Performed BEFORE the deposits.status
  --    update, so a failure here leaves the deposit non-terminal
  --    and a retry actually re-attempts the credit instead of
  --    silently no-op'ing on an already-'completed' row.
  SELECT * INTO v_ledger_result
  FROM atomic_wallet_operation(
    v_deposit.user_id,
    p_freti_amount,
    0::NUMERIC,
    0::NUMERIC,
    'deposit_mint'::VARCHAR,
    'deposit'::VARCHAR,
    v_deposit.id,
    v_idempotency_key::VARCHAR,
    format('Deposit: %s %s -> FRETI %s', COALESCE(p_local_amount, p_freti_amount), COALESCE(p_local_currency, 'USD'), p_freti_amount),
    '{}'::JSONB,
    v_deposit.user_id
  );

  IF NOT v_ledger_result.success THEN
    RAISE EXCEPTION 'Ledger credit failed for deposit %: %', v_deposit.id, v_ledger_result.error_message;
  END IF;

  -- 5. Only now that the wallet has been credited in this same
  --    transaction, mark the deposit completed.
  UPDATE deposits
  SET
    freti_amount = p_freti_amount,
    exchange_rate = p_exchange_rate,
    status = 'completed',
    external_payment_id = COALESCE(p_external_payment_id, external_payment_id),
    webhook_data = COALESCE(p_webhook_data, webhook_data),
    completed_at = NOW(),
    metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
      'local_amount_actual', p_local_amount,
      'local_currency', p_local_currency,
      'webhook_processed_at', NOW()
    )
  WHERE id = v_deposit.id;

  RETURN jsonb_build_object(
    'success', true,
    'already_processed', false,
    'deposit_status', 'completed',
    'ledger_entry_id', v_ledger_result.ledger_entry_id
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error in complete_deposit_credit: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during deposit completion',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION complete_deposit_credit IS
'Atomically credits a wallet for a completed Flutterwave deposit and marks the deposit row completed in one transaction. Uses a stable idempotency key (deposit_id + external_payment_id) to prevent double-crediting on retries or concurrent webhooks. Delegates wallet-row locking and balance updates to atomic_wallet_operation.';

REVOKE ALL ON FUNCTION complete_deposit_credit(UUID, NUMERIC, TEXT, NUMERIC, NUMERIC, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_deposit_credit(UUID, NUMERIC, TEXT, NUMERIC, NUMERIC, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION complete_deposit_credit(UUID, NUMERIC, TEXT, NUMERIC, NUMERIC, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION complete_deposit_credit(UUID, NUMERIC, TEXT, NUMERIC, NUMERIC, TEXT, JSONB) TO service_role;
ALTER FUNCTION complete_deposit_credit(UUID, NUMERIC, TEXT, NUMERIC, NUMERIC, TEXT, JSONB) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
--   select has_function_privilege('service_role', 'complete_deposit_credit(uuid,numeric,text,numeric,numeric,text,jsonb)', 'EXECUTE') as service_role_can_call,
--          has_function_privilege('authenticated', 'complete_deposit_credit(uuid,numeric,text,numeric,numeric,text,jsonb)', 'EXECUTE') as authenticated_can_call;
--
-- Expected: service_role_can_call = true, authenticated_can_call = false.
--
-- Next step: replace the two manual operations in
-- handleDepositWebhook's success branch with a single call to
-- this RPC.
-- =====================================================
