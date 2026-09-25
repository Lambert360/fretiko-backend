-- ============================================================
-- Migration 218: Add 'removed' status to products and services
-- ============================================================
-- Problem: Admin content moderation (rejectProduct/rejectService)
-- and vendor "hide" both write status = 'inactive'. A vendor could
-- simply unhide an admin-rejected item and undo the moderation.
--
-- Fix: introduce a dedicated 'removed' status that only staff can
-- set (admin.service.ts). Vendor-facing update endpoints reject
-- status changes on removed items, so moderation can't be undone
-- by the seller. Items previously rejected sit on 'inactive' and
-- can't be distinguished from vendor-hidden ones — not retrofixable.
-- ============================================================

-- Products: draft | active | sold | inactive | removed
ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_status_check;

ALTER TABLE public.products
  ADD CONSTRAINT products_status_check
  CHECK (status IN ('draft', 'active', 'sold', 'inactive', 'removed'));

-- Services: draft | active | busy | inactive | removed
ALTER TABLE public.services
  DROP CONSTRAINT IF EXISTS services_status_check;

ALTER TABLE public.services
  ADD CONSTRAINT services_status_check
  CHECK (status IN ('draft', 'active', 'busy', 'inactive', 'removed'));

-- Verify
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_status_check'
  ) THEN
    RAISE NOTICE 'products_status_check updated — removed allowed';
  ELSE
    RAISE WARNING 'products_status_check constraint not found';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'services_status_check'
  ) THEN
    RAISE NOTICE 'services_status_check updated — removed allowed';
  ELSE
    RAISE WARNING 'services_status_check constraint not found';
  END IF;
END $$;
