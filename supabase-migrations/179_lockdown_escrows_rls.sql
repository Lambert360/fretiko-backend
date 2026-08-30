-- =====================================================
-- Migration: 179
-- Lock down escrows table RLS to prevent authenticated users
-- from directly mutating escrow status or inserting escrows,
-- which would bypass release_escrow_atomic / refund logic.
--
-- Background:
--   add-escrow-rls-policies.sql created an UPDATE policy that
--   allowed any buyer, vendor, or rider involved in the related
--   order to UPDATE the escrow row. The policy had no status,
--   column, or state-machine restriction, meaning an authenticated
--   user could PATCH escrows.status to 'released' or 'refunded'
--   directly through PostgREST, skipping the atomic RPC and
--   leaving wallets unpaid / unreconciled.
--
--   It also created an INSERT policy allowing 'authenticated'
--   to insert escrows (with check on auth.role()). Only the
--   backend service should create or update escrow records.
--
--   This migration keeps SELECT open to involved users (they
--   still need to see their escrow state), but removes all
--   authenticated INSERT / UPDATE / DELETE access. The backend
--   already uses the service_role client for all escrow DML.
--
--   This is a permission-only migration and does not modify
--   table structure or existing data, so it cannot regress
--   any legitimate flow.
-- =====================================================

BEGIN;

-- 1. Remove all default grants on escrows.
--    Default Supabase privileges may have granted SELECT/INSERT/UPDATE
--    to PUBLIC, anon and authenticated automatically; explicit REVOKE
--    is required regardless. We then re-grant only the minimum below.
REVOKE ALL ON public.escrows FROM PUBLIC;
REVOKE ALL ON public.escrows FROM anon;
REVOKE ALL ON public.escrows FROM authenticated;

-- 2. Re-grant the minimum: authenticated can see their own escrows;
--    service_role can perform all escrow DML.
GRANT SELECT ON public.escrows TO authenticated;
GRANT ALL ON public.escrows TO service_role;

-- 3. Drop the overly permissive UPDATE and INSERT policies,
--    plus any policies that use the names we are about to create.
DROP POLICY IF EXISTS "Users can update escrows they are involved in" ON public.escrows;
DROP POLICY IF EXISTS "Service can create escrows" ON public.escrows;
-- Also drop the older name variants that may exist from MASTER_ESCROW_SYSTEM_MIGRATION.sql
DROP POLICY IF EXISTS "Authenticated users can view their related escrows" ON public.escrows;
DROP POLICY IF EXISTS "Service role can insert escrows" ON public.escrows;
DROP POLICY IF EXISTS "Service role can update escrows" ON public.escrows;
DROP POLICY IF EXISTS "Service role can manage all escrows" ON public.escrows;
-- New names we will create below (prevent 42710 duplicate-name failure)
DROP POLICY IF EXISTS escrows_view_participants ON public.escrows;
DROP POLICY IF EXISTS escrows_select_participant ON public.escrows;
DROP POLICY IF EXISTS escrows_service_all ON public.escrows;

-- 4. Re-create a minimal, correct policy set.
--    Authenticated users can view escrows where they are the
--    buyer, vendor, or rider of the related order.
CREATE POLICY "escrows_view_participants" ON public.escrows
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.orders
    WHERE orders.id = escrows.order_id
      AND (
        orders.buyer_id = auth.uid()
        OR orders.vendor_id = auth.uid()
        OR orders.rider_id = auth.uid()
      )
  )
);

-- 5. Service role can do anything on escrows.
CREATE POLICY "escrows_service_all" ON public.escrows
FOR ALL TO service_role
USING (true)
WITH CHECK (true);

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
--   select r.rolname, has_table_privilege(r.oid, 'public.escrows', 'SELECT') as can_select,
--          has_table_privilege(r.oid, 'public.escrows', 'INSERT') as can_insert,
--          has_table_privilege(r.oid, 'public.escrows', 'UPDATE') as can_update,
--          has_table_privilege(r.oid, 'public.escrows', 'DELETE') as can_delete
--   from pg_roles r
--   where r.rolname in ('anon','authenticated','service_role');
--
-- Expected:
--   anon:          select=false, insert=false, update=false, delete=false
--   authenticated: select=true,  insert=false, update=false, delete=false
--   service_role:  all true
-- =====================================================
