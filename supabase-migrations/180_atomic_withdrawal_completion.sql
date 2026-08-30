-- =====================================================
-- Migration: 180
-- Add complete_withdrawal_transfer(): a single atomic RPC that
-- transitions a payout_requests row to its terminal state AND
-- performs the corresponding wallet_ledger movement in one
-- Postgres transaction.
--
-- Background (the exact bug this fixes):
--   handleWithdrawalWebhook() in wallet.service.ts, on a
--   'transfer.completed' / SUCCESSFUL event, currently does:
--     1. UPDATE payout_requests SET status = 'paid' ...
--     2. createLedgerEntry(...) -> RPC atomic_wallet_operation
--        (burns the pending_withdrawal hold)
--   These are two separate network round-trips, not one
--   transaction. If step 2 throws after step 1 has already
--   committed, the payout is left permanently marked 'paid'
--   while the funds are still sitting in pending_withdrawal -
--   because the idempotency guard at the top of
--   handleWithdrawalWebhook returns early for any payout
--   already in a terminal state ('paid'/'failed'/'cancelled').
--   A retried webhook can never repair this: the money is
--   effectively stuck (booked as paid out, but never actually
--   debited from pending_withdrawal).
--
--   This is very likely how a "$5 balance, $700 withdrawn"
--   style incident happens elsewhere: a partial completion
--   leaves the ledger and the payout record disagreeing about
--   how much has actually left the wallet.
--
--   The 'transfer.failed' branch already does the ledger
--   operation before the status update, so it does not have
--   this defect - only the success path needs consolidation.
--
-- What this migration does:
--   Adds complete_withdrawal_transfer(), which locks the
--   payout_requests row FOR UPDATE, validates the state
--   transition, performs the wallet_ledger movement via the
--   existing atomic_wallet_operation() (still locks the wallet
--   row FOR UPDATE, still idempotent on
--   wallet_ledger.idempotency_key), and updates payout_requests
--   to its terminal state - all inside one function invocation,
--   which PostgREST executes as a single transaction. If the
--   ledger step fails, the payout status update never happens,
--   so a retry will correctly re-attempt the ledger step instead
--   of silently no-op'ing.
--
--   This is additive only - it does not modify or drop
--   process_wallet_transaction, atomic_wallet_operation, or the
--   payout_requests table. Wiring wallet.service.ts to call it
--   instead of the current two-step sequence is a separate,
--   follow-up change so this migration alone cannot regress the
--   current (imperfect but working) flow.
-- =====================================================

BEGIN;

CREATE OR REPLACE FUNCTION complete_withdrawal_transfer(
  p_payout_id UUID,
  p_event_status TEXT,             -- 'paid' or 'failed'
  p_transfer_id TEXT DEFAULT NULL,
  p_local_amount NUMERIC DEFAULT NULL,
  p_local_currency TEXT DEFAULT NULL,
  p_exchange_rate NUMERIC DEFAULT NULL,
  p_failure_reason TEXT DEFAULT NULL,
  p_webhook_data JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_payout RECORD;
  v_idempotency_key TEXT;
  v_ledger_result RECORD;
BEGIN
  IF p_event_status NOT IN ('paid', 'failed') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Invalid p_event_status, must be paid or failed',
      'error_code', 'INVALID_STATUS'
    );
  END IF;

  -- 1. Lock the payout row for the duration of this transaction.
  SELECT * INTO v_payout
  FROM payout_requests
  WHERE id = p_payout_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Payout not found',
      'error_code', 'PAYOUT_NOT_FOUND'
    );
  END IF;

  -- 2. Idempotency / terminal-state guard (mirrors the check
  --    handleWithdrawalWebhook already performs before calling
  --    this function, kept here as defense in depth since this
  --    function may also be called by admin tooling).
  IF v_payout.status IN ('paid', 'failed', 'cancelled') THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_processed', true,
      'payout_status', v_payout.status
    );
  END IF;

  IF p_event_status = 'paid' THEN
    v_idempotency_key := 'withdrawal_completed_' || v_payout.id || '_' || COALESCE(p_transfer_id, 'webhook');

    -- 3a. Burn the pending_withdrawal hold. This still goes
    --     through atomic_wallet_operation, so the wallet row is
    --     still locked FOR UPDATE and wallet_ledger's unique
    --     idempotency_key still protects against duplicate burns.
    SELECT * INTO v_ledger_result
    FROM atomic_wallet_operation(
      v_payout.user_id,
      0::NUMERIC,
      0::NUMERIC,
      -v_payout.freti_amount,
      'withdrawal_burn'::VARCHAR,
      'payout_request'::VARCHAR,
      v_payout.id,
      v_idempotency_key::VARCHAR,
      format('Withdrawal completed: FRETI %s -> %s %s', v_payout.freti_amount, COALESCE(p_local_amount, v_payout.freti_amount), COALESCE(p_local_currency, v_payout.local_currency)),
      '{}'::JSONB,
      v_payout.user_id
    );

    IF NOT v_ledger_result.success THEN
      -- Raising rolls back this entire function call, including
      -- any changes so far (none yet) - payout_requests.status
      -- is NOT updated, so the payout remains non-terminal and a
      -- retried webhook will correctly retry this ledger step
      -- instead of silently skipping it.
      RAISE EXCEPTION 'Ledger burn failed for payout %: %', v_payout.id, v_ledger_result.error_message;
    END IF;

    -- 3b. Only now, with the ledger movement already committed
    --     in this same transaction, mark the payout terminal.
    UPDATE payout_requests
    SET
      status = 'paid',
      estimated_local_amount = COALESCE(p_local_amount, estimated_local_amount),
      local_currency = COALESCE(p_local_currency, local_currency),
      external_payout_id = COALESCE(p_transfer_id, external_payout_id),
      webhook_data = COALESCE(p_webhook_data, webhook_data),
      paid_at = NOW(),
      metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
        'exchange_rate', p_exchange_rate,
        'usd_amount', v_payout.freti_amount,
        'local_amount_actual', p_local_amount,
        'webhook_processed_at', NOW()
      )
    WHERE id = v_payout.id;

    RETURN jsonb_build_object(
      'success', true,
      'already_processed', false,
      'payout_status', 'paid',
      'ledger_entry_id', v_ledger_result.ledger_entry_id
    );

  ELSE -- p_event_status = 'failed'
    v_idempotency_key := 'withdrawal_refund_' || v_payout.id || '_' || COALESCE(p_transfer_id, 'webhook') || '_failed';

    SELECT * INTO v_ledger_result
    FROM atomic_wallet_operation(
      v_payout.user_id,
      v_payout.freti_amount,
      0::NUMERIC,
      -v_payout.freti_amount,
      'withdrawal_burn'::VARCHAR,
      'payout_request'::VARCHAR,
      v_payout.id,
      v_idempotency_key::VARCHAR,
      format('Withdrawal failed - funds refunded to available balance. Reason: %s', COALESCE(p_failure_reason, 'Transfer failed')),
      '{}'::JSONB,
      v_payout.user_id
    );

    IF NOT v_ledger_result.success THEN
      RAISE EXCEPTION 'Ledger refund failed for payout %: %', v_payout.id, v_ledger_result.error_message;
    END IF;

    UPDATE payout_requests
    SET
      status = 'failed',
      failure_reason = p_failure_reason,
      external_payout_id = COALESCE(p_transfer_id, external_payout_id),
      webhook_data = COALESCE(p_webhook_data, webhook_data),
      metadata = COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
        'webhook_processed_at', NOW(),
        'failure_reason_details', p_failure_reason
      )
    WHERE id = v_payout.id;

    RETURN jsonb_build_object(
      'success', true,
      'already_processed', false,
      'payout_status', 'failed',
      'ledger_entry_id', v_ledger_result.ledger_entry_id
    );
  END IF;

EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Error in complete_withdrawal_transfer: %', SQLERRM;
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Internal error during withdrawal completion',
      'error_code', 'INTERNAL_ERROR',
      'error_message', SQLERRM
    );
END;
$$;

COMMENT ON FUNCTION complete_withdrawal_transfer IS
'Atomically transitions a payout_requests row to paid/failed and performs the matching wallet_ledger movement in one transaction, closing the window where a webhook retry could leave a payout marked paid/failed without the corresponding ledger entry. Locks payout_requests FOR UPDATE; delegates wallet-row locking and idempotency to atomic_wallet_operation.';

-- Same security posture as the rest of the financial RPCs locked
-- down in migration 177: service_role only.
REVOKE ALL ON FUNCTION complete_withdrawal_transfer(UUID, TEXT, TEXT, NUMERIC, TEXT, NUMERIC, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_withdrawal_transfer(UUID, TEXT, TEXT, NUMERIC, TEXT, NUMERIC, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION complete_withdrawal_transfer(UUID, TEXT, TEXT, NUMERIC, TEXT, NUMERIC, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION complete_withdrawal_transfer(UUID, TEXT, TEXT, NUMERIC, TEXT, NUMERIC, TEXT, JSONB) TO service_role;
ALTER FUNCTION complete_withdrawal_transfer(UUID, TEXT, TEXT, NUMERIC, TEXT, NUMERIC, TEXT, JSONB) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
--   select has_function_privilege('service_role', 'complete_withdrawal_transfer(uuid,text,text,numeric,text,numeric,text,jsonb)', 'EXECUTE') as service_role_can_call,
--          has_function_privilege('authenticated', 'complete_withdrawal_transfer(uuid,text,text,numeric,text,numeric,text,jsonb)', 'EXECUTE') as authenticated_can_call;
--
-- Expected: service_role_can_call = true, authenticated_can_call = false.
--
-- This migration does NOT change any existing behavior by itself -
-- wallet.service.ts is not modified yet. The next step (a
-- follow-up, separately reviewed change) is to replace the two
-- manual steps in handleWithdrawalWebhook's success/failure
-- branches with a single call to this RPC.
-- =====================================================
