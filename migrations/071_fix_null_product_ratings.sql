-- Migration: Fix NULL rating values in products and services
-- Date: 2025-01-29
-- Description: Sets all NULL average_rating and review_count values to 0
--              to ensure consistent data for display

-- ================================
-- FIX PRODUCTS TABLE
-- ================================

-- Update NULL average_rating values to 0
UPDATE products
SET average_rating = 0
WHERE average_rating IS NULL;

-- Update NULL review_count values to 0
UPDATE products
SET review_count = 0
WHERE review_count IS NULL;

-- Recalculate all product ratings from actual review data
UPDATE products p
SET
    average_rating = COALESCE((
        SELECT AVG(rating)::DECIMAL(3,2)
        FROM product_ratings pr
        WHERE pr.product_id = p.id
    ), 0),
    review_count = COALESCE((
        SELECT COUNT(*)::INTEGER
        FROM product_ratings pr
        WHERE pr.product_id = p.id
    ), 0);

-- ================================
-- FIX SERVICES TABLE
-- ================================

-- Update NULL average_rating values to 0
UPDATE services
SET average_rating = 0
WHERE average_rating IS NULL;

-- Update NULL review_count values to 0
UPDATE services
SET review_count = 0
WHERE review_count IS NULL;

-- Recalculate all service ratings from actual review data
UPDATE services s
SET
    average_rating = COALESCE((
        SELECT AVG(rating)::DECIMAL(3,2)
        FROM service_ratings sr
        WHERE sr.service_id = s.id
    ), 0),
    review_count = COALESCE((
        SELECT COUNT(*)::INTEGER
        FROM service_ratings sr
        WHERE sr.service_id = s.id
    ), 0);

-- ================================
-- ADD NOT NULL CONSTRAINTS
-- ================================

-- Make columns NOT NULL to prevent future NULL values
ALTER TABLE products
    ALTER COLUMN average_rating SET NOT NULL,
    ALTER COLUMN review_count SET NOT NULL;

ALTER TABLE services
    ALTER COLUMN average_rating SET NOT NULL,
    ALTER COLUMN review_count SET NOT NULL;

-- ================================
-- VERIFICATION
-- ================================

DO $$
DECLARE
    product_null_count INTEGER;
    service_null_count INTEGER;
    product_total INTEGER;
    service_total INTEGER;
    product_with_reviews INTEGER;
    service_with_reviews INTEGER;
BEGIN
    -- Check for remaining NULL values
    SELECT
        COUNT(*) FILTER (WHERE average_rating IS NULL OR review_count IS NULL),
        COUNT(*),
        COUNT(*) FILTER (WHERE review_count > 0)
    INTO product_null_count, product_total, product_with_reviews
    FROM products;

    SELECT
        COUNT(*) FILTER (WHERE average_rating IS NULL OR review_count IS NULL),
        COUNT(*),
        COUNT(*) FILTER (WHERE review_count > 0)
    INTO service_null_count, service_total, service_with_reviews
    FROM services;

    -- Report results
    RAISE NOTICE '========================================';
    RAISE NOTICE 'MIGRATION VERIFICATION REPORT';
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Products:';
    RAISE NOTICE '  - Total products: %', product_total;
    RAISE NOTICE '  - Products with reviews: %', product_with_reviews;
    RAISE NOTICE '  - Remaining NULL values: %', product_null_count;
    RAISE NOTICE '';
    RAISE NOTICE 'Services:';
    RAISE NOTICE '  - Total services: %', service_total;
    RAISE NOTICE '  - Services with reviews: %', service_with_reviews;
    RAISE NOTICE '  - Remaining NULL values: %', service_null_count;
    RAISE NOTICE '========================================';

    IF product_null_count = 0 AND service_null_count = 0 THEN
        RAISE NOTICE '✅ SUCCESS: All NULL rating values fixed!';
    ELSE
        RAISE WARNING '⚠️ WARNING: Some NULL values remain. Manual intervention may be needed.';
    END IF;
END $$;

-- Display sample of products with ratings
SELECT
    id,
    name,
    average_rating,
    review_count,
    created_at
FROM products
ORDER BY review_count DESC
LIMIT 10;
