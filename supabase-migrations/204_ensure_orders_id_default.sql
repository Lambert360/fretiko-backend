-- =====================================================
-- Migration: 204
-- Fix: Ensure orders.id is never NULL on insert
--
-- Background:
--   The atomic order RPCs (197, 199, 200, 201) build an orders row from
--   a JSONB payload and strip the client-supplied 'id' before inserting:
--
--     INSERT INTO orders
--     SELECT * FROM jsonb_populate_record(null::orders, v_order_json);
--
--   Because the resulting row has id = NULL, the insert fails with:
--     "null value in column "id" of relation "orders" violates not-null constraint"
--
--   The table already has id DEFAULT gen_random_uuid(), but that default is
--   not used when an explicit NULL is supplied by the SELECT.
--
--   This trigger is a defensive guard: if an INSERT arrives with id = NULL,
--   it assigns a new UUID before the row is written. It fixes all four
--   order-creation RPCs without duplicating their large bodies.
-- =====================================================

BEGIN;

-- Trigger function to back-fill a missing order id.
CREATE OR REPLACE FUNCTION public.ensure_order_id_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.ensure_order_id_on_insert() IS
'Defensive trigger: assigns a UUID to orders.id when an insert supplies NULL.';

-- Drop any previous incarnation of the trigger and recreate it.
DROP TRIGGER IF EXISTS ensure_order_id_on_insert ON public.orders;

CREATE TRIGGER ensure_order_id_on_insert
BEFORE INSERT ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.ensure_order_id_on_insert();

COMMIT;

-- =====================================================
-- Verification (run manually after applying):
--
-- INSERT INTO orders (order_number, buyer_id, vendor_id, total_amount, delivery_fee, platform_fee, status, escrow_enabled)
-- VALUES ('TEST-204', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 0, 0, 0, 'pending', false)
-- RETURNING id;
--
-- Expected: id is a generated UUID, not NULL.
-- =====================================================
