-- Cleanup Script: Fix invalid order_items before applying constraint
-- Run this BEFORE running 096_add_service_order_support.sql

-- Step 1: Identify problematic rows (product_id is NULL)
SELECT 
  id, 
  order_id, 
  product_id,
  product_name,
  quantity,
  unit_price,
  created_at
FROM public.order_items 
WHERE product_id IS NULL
ORDER BY created_at DESC;

-- Step 2: Show how many problematic rows exist
SELECT 
  COUNT(*) as problematic_rows,
  'Rows with NULL product_id' as description
FROM public.order_items 
WHERE product_id IS NULL;

-- Step 3: DELETE the problematic rows
-- UNCOMMENT the line below to actually delete them
-- WARNING: This will permanently delete these order items!

-- DELETE FROM public.order_items 
-- WHERE product_id IS NULL;

-- Step 4: After deletion, verify
-- SELECT COUNT(*) FROM public.order_items WHERE product_id IS NULL;
-- Should return 0

-- Alternative Step 3: If you don't want to delete, try to fix them
-- This attempts to link them to products based on product_name
-- UNCOMMENT to use this approach instead

/*
UPDATE public.order_items oi
SET product_id = p.id
FROM public.products p
WHERE oi.product_id IS NULL 
  AND oi.product_name IS NOT NULL
  AND p.name = oi.product_name
  AND EXISTS (
    SELECT 1 FROM public.orders o 
    WHERE o.id = oi.order_id 
    AND o.vendor_id = p.user_id
  );
*/

-- Step 5: Check what remains unfixed
SELECT 
  COUNT(*) as remaining_problematic_rows
FROM public.order_items 
WHERE product_id IS NULL;

