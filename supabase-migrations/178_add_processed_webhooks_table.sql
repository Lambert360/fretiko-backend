-- =====================================================
-- Migration: 178
-- Add processed_webhooks table: atomic dedup layer for
-- payment-provider webhooks (Flutterwave deposit/withdrawal
-- callbacks today; usable for any future provider).
--
-- Why:
--   handleDepositWebhook / handleWithdrawalWebhook in
--   wallet.service.ts currently deduplicate by re-reading
--   deposits.status / payout_requests.status ("if already
--   completed/paid, skip"). That check-then-act is not atomic:
--   two near-simultaneous webhook deliveries for the same event
--   can both read a non-terminal status and both proceed.
--
--   This table gives an atomic claim primitive: attempt to
--   INSERT the provider's event id first (unique, PK-enforced);
--   only the request whose INSERT succeeds should process the
--   event. This is additive only - no existing table, function,
--   or application code path is modified by this migration, so
--   it cannot regress current behavior. Wiring it into
--   wallet.service.ts is a separate, follow-up change.
--
-- Access:
--   service_role only, consistent with wallets/wallet_ledger.
-- =====================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.processed_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,                 -- e.g. 'flutterwave'
  event_id TEXT NOT NULL,                 -- provider's unique event/transaction id
  event_type TEXT,                        -- e.g. 'charge.completed', 'transfer.completed'
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
  reference_id TEXT,                      -- deposit_id / payout_id this event relates to, if known
  payload JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_processed_webhooks_reference_id
  ON public.processed_webhooks(reference_id);

CREATE INDEX IF NOT EXISTS idx_processed_webhooks_status
  ON public.processed_webhooks(status)
  WHERE status = 'processing';

ALTER TABLE public.processed_webhooks ENABLE ROW LEVEL SECURITY;

-- No anon/authenticated policies are created intentionally:
-- with RLS enabled and no policy for a role, that role gets
-- zero rows / zero writes. Only service_role (which bypasses
-- RLS) can access this table - exactly matching wallet_ledger's
-- access model.
CREATE POLICY processed_webhooks_service_all ON public.processed_webhooks
FOR ALL TO service_role
USING (true)
WITH CHECK (true);

REVOKE ALL ON public.processed_webhooks FROM PUBLIC;
REVOKE ALL ON public.processed_webhooks FROM anon;
REVOKE ALL ON public.processed_webhooks FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON public.processed_webhooks TO service_role;

COMMIT;

-- =====================================================
-- Intended usage pattern (to be wired into
-- wallet.service.ts#handleDepositWebhook /
-- #handleWithdrawalWebhook in a follow-up change):
--
--   INSERT INTO processed_webhooks (provider, event_id, event_type, reference_id, payload)
--   VALUES ('flutterwave', :event_id, :event_type, :reference_id, :payload)
--   ON CONFLICT (provider, event_id) DO NOTHING
--   RETURNING id;
--
--   -- If no row is returned, this event was already claimed by
--   -- another request/retry - return 200 immediately without
--   -- reprocessing. If a row is returned, proceed with the
--   -- existing verification + ledger logic, then UPDATE the row
--   -- to status = 'completed' (or 'failed') at the end.
-- =====================================================
