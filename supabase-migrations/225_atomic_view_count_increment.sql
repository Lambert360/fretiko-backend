-- ============================================================
-- Migration 225: Atomic product view_count increment
-- ============================================================
-- ProductsService.recordProductEvent/getProduct previously did a
-- read-modify-write on products.view_count (SELECT then UPDATE +1).
-- Two concurrent views both read the same value and one increment is
-- lost. Moving the arithmetic into Postgres makes it a single atomic
-- UPDATE — no lost increments under concurrent traffic.
--
-- Idempotent: CREATE OR REPLACE is a no-op redefinition if re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION public.increment_view_count(p_product_id uuid)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.products
     SET view_count = COALESCE(view_count, 0) + 1
   WHERE id = p_product_id;
$$;

COMMENT ON FUNCTION public.increment_view_count(uuid) IS
  'Atomically increments products.view_count by 1. Replaces client-side read-modify-write.';
