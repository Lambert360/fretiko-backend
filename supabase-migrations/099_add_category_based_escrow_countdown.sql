-- Migration: Add category-based escrow countdown support
-- Description: Adds category column to order_items and countdown tracking to escrows for category-based auto-release timing

-- =====================================================
-- PART 1: Add category column to order_items
-- =====================================================

-- Add category column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'order_items' 
        AND column_name = 'category'
    ) THEN
        ALTER TABLE public.order_items ADD COLUMN category TEXT;
        RAISE NOTICE '✅ Added category column to order_items';
    ELSE
        RAISE NOTICE 'ℹ️ category column already exists in order_items';
    END IF;
END $$;

-- Backfill category data from products and services
DO $$
DECLARE
    updated_count INTEGER;
BEGIN
    -- Update product-based order items
    UPDATE public.order_items oi
    SET category = COALESCE(pc.name, 'General')
    FROM public.products p
    LEFT JOIN public.product_categories pc ON p.category_id = pc.id
    WHERE oi.product_id = p.id 
    AND oi.category IS NULL;
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RAISE NOTICE '✅ Updated % product order items with categories', updated_count;
    
    -- Update service-based order items
    UPDATE public.order_items oi
    SET category = COALESCE(sc.name, 'Services')
    FROM public.services s
    LEFT JOIN public.service_categories sc ON s.category_id = sc.id
    WHERE oi.service_id = s.id 
    AND oi.category IS NULL;
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RAISE NOTICE '✅ Updated % service order items with categories', updated_count;
    
    -- Set default for any remaining NULL categories
    UPDATE public.order_items
    SET category = 'General'
    WHERE category IS NULL;
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RAISE NOTICE '✅ Set default category for % remaining items', updated_count;
    
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE '⚠️ Error backfilling categories: %', SQLERRM;
END $$;

-- Add index for category queries
CREATE INDEX IF NOT EXISTS idx_order_items_category ON public.order_items(category);

-- Add comment
COMMENT ON COLUMN public.order_items.category IS 'Product or service category for countdown calculation (e.g., Food, Electronics, Services)';

-- =====================================================
-- PART 2: Add countdown tracking to escrows
-- =====================================================

-- Add countdown_hours column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'escrows' 
        AND column_name = 'countdown_hours'
    ) THEN
        ALTER TABLE public.escrows ADD COLUMN countdown_hours INTEGER DEFAULT 24;
        RAISE NOTICE '✅ Added countdown_hours column to escrows';
    ELSE
        RAISE NOTICE 'ℹ️ countdown_hours column already exists in escrows';
    END IF;
END $$;

-- Add category_based flag if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'escrows' 
        AND column_name = 'category_based'
    ) THEN
        ALTER TABLE public.escrows ADD COLUMN category_based BOOLEAN DEFAULT FALSE;
        RAISE NOTICE '✅ Added category_based column to escrows';
    ELSE
        RAISE NOTICE 'ℹ️ category_based column already exists in escrows';
    END IF;
END $$;

-- Add primary_category column to track which category determined the countdown
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'escrows' 
        AND column_name = 'primary_category'
    ) THEN
        ALTER TABLE public.escrows ADD COLUMN primary_category TEXT;
        RAISE NOTICE '✅ Added primary_category column to escrows';
    ELSE
        RAISE NOTICE 'ℹ️ primary_category column already exists in escrows';
    END IF;
END $$;

-- Add comments
COMMENT ON COLUMN public.escrows.countdown_hours IS 'Hours until auto-release based on order category (e.g., 3 for food, 24 for general, 72 for electronics)';
COMMENT ON COLUMN public.escrows.category_based IS 'Flag indicating if countdown was calculated based on category rules';
COMMENT ON COLUMN public.escrows.primary_category IS 'The category that determined the countdown duration (shortest wins for multi-category orders)';

-- =====================================================
-- PART 3: Verification
-- =====================================================

DO $$
DECLARE
    order_items_category_exists BOOLEAN;
    escrows_countdown_exists BOOLEAN;
    total_items INTEGER;
    categorized_items INTEGER;
BEGIN
    -- Check order_items.category
    SELECT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'order_items' AND column_name = 'category'
    ) INTO order_items_category_exists;
    
    -- Check escrows.countdown_hours
    SELECT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_name = 'escrows' AND column_name = 'countdown_hours'
    ) INTO escrows_countdown_exists;
    
    -- Count categorized items
    SELECT COUNT(*) INTO total_items FROM public.order_items;
    SELECT COUNT(*) INTO categorized_items FROM public.order_items WHERE category IS NOT NULL;
    
    -- Report
    RAISE NOTICE '📋 Migration Verification:';
    RAISE NOTICE '  - order_items.category: %', CASE WHEN order_items_category_exists THEN '✅ EXISTS' ELSE '❌ MISSING' END;
    RAISE NOTICE '  - escrows.countdown_hours: %', CASE WHEN escrows_countdown_exists THEN '✅ EXISTS' ELSE '❌ MISSING' END;
    RAISE NOTICE '  - Total order items: %', total_items;
    RAISE NOTICE '  - Categorized items: % (%.1f%%)', categorized_items, (categorized_items::FLOAT / NULLIF(total_items, 0) * 100);
END $$;

