-- =====================================================
-- Migration: 177
-- SECURITY LOCKDOWN: Restrict financial / inventory-mutating
-- SECURITY DEFINER functions to service_role only.
--
-- Background:
--   process_wallet_transaction and send_gift_atomic were granted
--   EXECUTE to `authenticated`, and several other SECURITY DEFINER
--   money/inventory functions (atomic_wallet_operation,
--   validate_daily_limit, release_escrow_atomic,
--   update_live_stream_stock_atomic, restore_live_stream_stock_atomic,
--   update_portfolio_booking_stats, increment_redemption_attempts,
--   cleanup_expired_stock_reservations) never had an explicit REVOKE,
--   which means they are reachable by any logged-in Supabase Auth
--   session (and possibly anon) directly through PostgREST
--   (`/rest/v1/rpc/<function>`), completely bypassing the NestJS
--   backend, its validation, KYC checks, and daily limits.
--
--   None of these functions verify that the caller (auth.uid())
--   owns the account they are operating on, so a user could:
--     - mint funds into any wallet (process_wallet_transaction /
--       atomic_wallet_operation with a credit transaction type)
--     - drain any other user's virtual gift inventory
--       (send_gift_atomic with an arbitrary p_sender_id)
--     - release/manipulate escrow, stock, or gift-card redemption
--       counters outside of the intended order/checkout flow.
--
--   The entire backend already calls these functions using the
--   Supabase service_role key (see src/shared/supabase.client.ts:
--   createServiceSupabaseClient / createUserSupabaseClient both use
--   SUPABASE_SERVICE_ROLE_KEY). No legitimate client-side code path
--   (mobile app, web app, admin panel) calls these functions
--   directly - confirmed by repository-wide search. Restricting
--   these functions to service_role is therefore purely a
--   tightening of an unintentionally open door and does not change
--   any existing, legitimate call path.
--
--   This migration is additive/permission-only: it does not change
--   any function body, return type, or parameter signature, so no
--   application code changes are required.
-- =====================================================

BEGIN;

-- ---------------------------------------------------------
-- 1. Wallet ledger core (money creation/movement)
-- ---------------------------------------------------------

REVOKE ALL ON FUNCTION process_wallet_transaction(UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION process_wallet_transaction(UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION process_wallet_transaction(UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION process_wallet_transaction(UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT) TO service_role;
ALTER FUNCTION process_wallet_transaction(UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION atomic_wallet_operation(UUID, NUMERIC, NUMERIC, NUMERIC, VARCHAR, VARCHAR, UUID, VARCHAR, TEXT, JSONB, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION atomic_wallet_operation(UUID, NUMERIC, NUMERIC, NUMERIC, VARCHAR, VARCHAR, UUID, VARCHAR, TEXT, JSONB, UUID) FROM anon;
REVOKE ALL ON FUNCTION atomic_wallet_operation(UUID, NUMERIC, NUMERIC, NUMERIC, VARCHAR, VARCHAR, UUID, VARCHAR, TEXT, JSONB, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION atomic_wallet_operation(UUID, NUMERIC, NUMERIC, NUMERIC, VARCHAR, VARCHAR, UUID, VARCHAR, TEXT, JSONB, UUID) TO service_role;
ALTER FUNCTION atomic_wallet_operation(UUID, NUMERIC, NUMERIC, NUMERIC, VARCHAR, VARCHAR, UUID, VARCHAR, TEXT, JSONB, UUID) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION validate_daily_limit(UUID, NUMERIC, VARCHAR, VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION validate_daily_limit(UUID, NUMERIC, VARCHAR, VARCHAR) FROM anon;
REVOKE ALL ON FUNCTION validate_daily_limit(UUID, NUMERIC, VARCHAR, VARCHAR) FROM authenticated;
GRANT EXECUTE ON FUNCTION validate_daily_limit(UUID, NUMERIC, VARCHAR, VARCHAR) TO service_role;
ALTER FUNCTION validate_daily_limit(UUID, NUMERIC, VARCHAR, VARCHAR) SET search_path = public, pg_temp;

-- ---------------------------------------------------------
-- 2. Escrow release (vendor/rider/platform payouts)
-- ---------------------------------------------------------

REVOKE ALL ON FUNCTION release_escrow_atomic(UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_escrow_atomic(UUID, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION release_escrow_atomic(UUID, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION release_escrow_atomic(UUID, TEXT, UUID) TO service_role;
ALTER FUNCTION release_escrow_atomic(UUID, TEXT, UUID) SET search_path = public, pg_temp;

-- ---------------------------------------------------------
-- 3. Virtual gift inventory transfer
-- ---------------------------------------------------------

REVOKE ALL ON FUNCTION send_gift_atomic(UUID, UUID, UUID, INTEGER, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION send_gift_atomic(UUID, UUID, UUID, INTEGER, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION send_gift_atomic(UUID, UUID, UUID, INTEGER, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION send_gift_atomic(UUID, UUID, UUID, INTEGER, TEXT, UUID) TO service_role;
ALTER FUNCTION send_gift_atomic(UUID, UUID, UUID, INTEGER, TEXT, UUID) SET search_path = public, pg_temp;

-- ---------------------------------------------------------
-- 4. Gift card redemption attempt counter (brute-force guard)
-- ---------------------------------------------------------

REVOKE ALL ON FUNCTION increment_redemption_attempts(VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION increment_redemption_attempts(VARCHAR) FROM anon;
REVOKE ALL ON FUNCTION increment_redemption_attempts(VARCHAR) FROM authenticated;
GRANT EXECUTE ON FUNCTION increment_redemption_attempts(VARCHAR) TO service_role;
ALTER FUNCTION increment_redemption_attempts(VARCHAR) SET search_path = public, pg_temp;

-- ---------------------------------------------------------
-- 5. Live-sales stock / portfolio atomic mutators
--    (inventory/booking correctness, not directly money, but
--    still only ever called by the backend with service_role and
--    should not be reachable by end users directly)
--
--    NOTE: book_live_service_slot_atomic (migration 132) is not
--    present in the live database (per pg_proc check 2026-01-22),
--    so it is omitted here. update_portfolio_booking_stats, which
--    is present, is included below. If book_live_service_slot
--    is deployed later, it should be locked down in a follow-up
--    migration.
-- ---------------------------------------------------------

REVOKE ALL ON FUNCTION update_live_stream_stock_atomic(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_live_stream_stock_atomic(UUID, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION update_live_stream_stock_atomic(UUID, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION update_live_stream_stock_atomic(UUID, INTEGER) TO service_role;
ALTER FUNCTION update_live_stream_stock_atomic(UUID, INTEGER) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION restore_live_stream_stock_atomic(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION restore_live_stream_stock_atomic(UUID, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION restore_live_stream_stock_atomic(UUID, INTEGER) FROM authenticated;
GRANT EXECUTE ON FUNCTION restore_live_stream_stock_atomic(UUID, INTEGER) TO service_role;
ALTER FUNCTION restore_live_stream_stock_atomic(UUID, INTEGER) SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION cleanup_expired_stock_reservations() FROM PUBLIC;
REVOKE ALL ON FUNCTION cleanup_expired_stock_reservations() FROM anon;
REVOKE ALL ON FUNCTION cleanup_expired_stock_reservations() FROM authenticated;
GRANT EXECUTE ON FUNCTION cleanup_expired_stock_reservations() TO service_role;
ALTER FUNCTION cleanup_expired_stock_reservations() SET search_path = public, pg_temp;

-- Portfolio booking stats (SECURITY DEFINER; inflates bookings/revenue
-- if called directly by an authenticated user)
REVOKE ALL ON FUNCTION update_portfolio_booking_stats(UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_portfolio_booking_stats(UUID, NUMERIC) FROM anon;
REVOKE ALL ON FUNCTION update_portfolio_booking_stats(UUID, NUMERIC) FROM authenticated;
GRANT EXECUTE ON FUNCTION update_portfolio_booking_stats(UUID, NUMERIC) TO service_role;
ALTER FUNCTION update_portfolio_booking_stats(UUID, NUMERIC) SET search_path = public, pg_temp;

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
--   select p.proname, r.rolname, has_function_privilege(r.oid, p.oid, 'EXECUTE')
--   from pg_proc p
--   cross join (select oid, rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
--   where p.proname in (
--     'process_wallet_transaction','atomic_wallet_operation','validate_daily_limit',
--     'release_escrow_atomic','send_gift_atomic','increment_redemption_attempts',
--     'update_live_stream_stock_atomic','restore_live_stream_stock_atomic',
--     'update_portfolio_booking_stats','cleanup_expired_stock_reservations'
--   )
--   order by p.proname, r.rolname;
--
-- Expected: only service_role rows show `true`; anon/authenticated show `false`.
-- =====================================================
