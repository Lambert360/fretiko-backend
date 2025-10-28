-- Migration: Add service booking support to order_items
-- Description: Allows order_items to reference either products OR services, with service-specific fields

-- Step 1: Add service_id column to order_items (nullable, for service bookings)
ALTER TABLE public.order_items
ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES public.services(id) ON DELETE SET NULL;

-- Step 2: Add service scheduling fields
ALTER TABLE public.order_items
ADD COLUMN IF NOT EXISTS scheduled_date date,
ADD COLUMN IF NOT EXISTS scheduled_time time,
ADD COLUMN IF NOT EXISTS service_notes text;

-- Step 3: Check if there are any rows with BOTH product_id and service_id as NULL
-- If so, we need to handle them before adding the constraint
DO $$
BEGIN
  -- Check for problematic rows
  IF EXISTS (
    SELECT 1 FROM public.order_items 
    WHERE product_id IS NULL AND service_id IS NULL
  ) THEN
    -- Log the issue (will appear in migration output)
    RAISE NOTICE 'Found order_items with NULL product_id and service_id. These will cause constraint violation.';
    RAISE NOTICE 'You may need to clean up or delete these rows before proceeding.';
    RAISE NOTICE 'Run: SELECT id, order_id, product_id, service_id FROM order_items WHERE product_id IS NULL AND service_id IS NULL;';
  END IF;
END $$;

-- Step 4: Make product_id nullable (since service orders won't have a product_id)
-- But first, check if column is already nullable to avoid error
DO $$
BEGIN
  ALTER TABLE public.order_items
  ALTER COLUMN product_id DROP NOT NULL;
EXCEPTION
  WHEN others THEN
    -- Column might already be nullable or doesn't exist, continue
    RAISE NOTICE 'product_id column modification skipped (might already be nullable)';
END $$;

-- Step 5: Add check constraint ONLY if no violating rows exist
-- This prevents the error you encountered
DO $$
BEGIN
  -- Only add constraint if no violating rows exist
  IF NOT EXISTS (
    SELECT 1 FROM public.order_items 
    WHERE (product_id IS NULL AND service_id IS NULL) 
       OR (product_id IS NOT NULL AND service_id IS NOT NULL)
  ) THEN
    -- Safe to add constraint
    ALTER TABLE public.order_items
    ADD CONSTRAINT order_items_product_or_service_check
    CHECK (
      (product_id IS NOT NULL AND service_id IS NULL) OR
      (product_id IS NULL AND service_id IS NOT NULL)
    );
    RAISE NOTICE 'Constraint order_items_product_or_service_check added successfully';
  ELSE
    -- Violating rows exist, show them
    RAISE WARNING 'Cannot add constraint - violating rows exist. Run this query to see them:';
    RAISE WARNING 'SELECT id, order_id, product_id, service_id FROM order_items WHERE (product_id IS NULL AND service_id IS NULL) OR (product_id IS NOT NULL AND service_id IS NOT NULL);';
  END IF;
END $$;

-- Step 6: Create index for service_id lookups
CREATE INDEX IF NOT EXISTS idx_order_items_service_id ON public.order_items(service_id);

-- Step 7: Add comments
COMMENT ON COLUMN public.order_items.service_id IS 'Reference to services table for service bookings (mutually exclusive with product_id)';
COMMENT ON COLUMN public.order_items.scheduled_date IS 'Scheduled date for service booking';
COMMENT ON COLUMN public.order_items.scheduled_time IS 'Scheduled time for service booking';
COMMENT ON COLUMN public.order_items.service_notes IS 'Special notes/instructions for service provider';

-- Step 8: Show summary of order_items
DO $$
DECLARE
  total_rows int;
  product_rows int;
  service_rows int;
  null_rows int;
BEGIN
  SELECT COUNT(*) INTO total_rows FROM public.order_items;
  SELECT COUNT(*) INTO product_rows FROM public.order_items WHERE product_id IS NOT NULL;
  SELECT COUNT(*) INTO service_rows FROM public.order_items WHERE service_id IS NOT NULL;
  SELECT COUNT(*) INTO null_rows FROM public.order_items WHERE product_id IS NULL AND service_id IS NULL;
  
  RAISE NOTICE '=== Migration Summary ===';
  RAISE NOTICE 'Total order_items: %', total_rows;
  RAISE NOTICE 'Product orders: %', product_rows;
  RAISE NOTICE 'Service orders: %', service_rows;
  RAISE NOTICE 'Invalid rows (both NULL): %', null_rows;
  
  IF null_rows > 0 THEN
    RAISE WARNING 'You have % order_items with NULL product_id AND service_id!', null_rows;
    RAISE WARNING 'These rows need to be fixed or deleted before the constraint can be added.';
  END IF;
END $$;

