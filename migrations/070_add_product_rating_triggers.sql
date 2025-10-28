-- Migration: Add automatic triggers to update product ratings
-- Date: 2025-01-29
-- Description: Creates database triggers to automatically update average_rating and review_count
--              when product_ratings are inserted, updated, or deleted

-- ================================
-- DROP EXISTING TRIGGERS IF ANY
-- ================================

DROP TRIGGER IF EXISTS update_product_rating_on_insert ON product_ratings;
DROP TRIGGER IF EXISTS update_product_rating_on_update ON product_ratings;
DROP TRIGGER IF EXISTS update_product_rating_on_delete ON product_ratings;
DROP FUNCTION IF EXISTS update_product_rating_stats();

-- ================================
-- CREATE FUNCTION TO UPDATE RATINGS
-- ================================

CREATE OR REPLACE FUNCTION update_product_rating_stats()
RETURNS TRIGGER AS $$
DECLARE
    v_product_id UUID;
    v_avg_rating DECIMAL(3,2);
    v_review_count INTEGER;
BEGIN
    -- Determine which product_id to update
    IF TG_OP = 'DELETE' THEN
        v_product_id := OLD.product_id;
    ELSE
        v_product_id := NEW.product_id;
    END IF;

    -- Calculate the new average rating and count
    SELECT
        COALESCE(AVG(rating)::DECIMAL(3,2), 0),
        COALESCE(COUNT(*)::INTEGER, 0)
    INTO v_avg_rating, v_review_count
    FROM product_ratings
    WHERE product_id = v_product_id;

    -- Update the products table
    UPDATE products
    SET
        average_rating = v_avg_rating,
        review_count = v_review_count,
        updated_at = NOW()
    WHERE id = v_product_id;

    -- Log the update for debugging
    RAISE NOTICE 'Updated product % ratings: avg=%, count=%', v_product_id, v_avg_rating, v_review_count;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ================================
-- CREATE TRIGGERS
-- ================================

-- Trigger on INSERT: When a new review is added
CREATE TRIGGER update_product_rating_on_insert
    AFTER INSERT ON product_ratings
    FOR EACH ROW
    EXECUTE FUNCTION update_product_rating_stats();

-- Trigger on UPDATE: When a review is modified
CREATE TRIGGER update_product_rating_on_update
    AFTER UPDATE ON product_ratings
    FOR EACH ROW
    EXECUTE FUNCTION update_product_rating_stats();

-- Trigger on DELETE: When a review is removed
CREATE TRIGGER update_product_rating_on_delete
    AFTER DELETE ON product_ratings
    FOR EACH ROW
    EXECUTE FUNCTION update_product_rating_stats();

-- ================================
-- CREATE SERVICE RATING TRIGGERS (for consistency)
-- ================================

DROP TRIGGER IF EXISTS update_service_rating_on_insert ON service_ratings;
DROP TRIGGER IF EXISTS update_service_rating_on_update ON service_ratings;
DROP TRIGGER IF EXISTS update_service_rating_on_delete ON service_ratings;
DROP FUNCTION IF EXISTS update_service_rating_stats();

CREATE OR REPLACE FUNCTION update_service_rating_stats()
RETURNS TRIGGER AS $$
DECLARE
    v_service_id UUID;
    v_avg_rating DECIMAL(3,2);
    v_review_count INTEGER;
BEGIN
    -- Determine which service_id to update
    IF TG_OP = 'DELETE' THEN
        v_service_id := OLD.service_id;
    ELSE
        v_service_id := NEW.service_id;
    END IF;

    -- Calculate the new average rating and count
    SELECT
        COALESCE(AVG(rating)::DECIMAL(3,2), 0),
        COALESCE(COUNT(*)::INTEGER, 0)
    INTO v_avg_rating, v_review_count
    FROM service_ratings
    WHERE service_id = v_service_id;

    -- Update the services table
    UPDATE services
    SET
        average_rating = v_avg_rating,
        review_count = v_review_count,
        updated_at = NOW()
    WHERE id = v_service_id;

    -- Log the update for debugging
    RAISE NOTICE 'Updated service % ratings: avg=%, count=%', v_service_id, v_avg_rating, v_review_count;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Create service rating triggers
CREATE TRIGGER update_service_rating_on_insert
    AFTER INSERT ON service_ratings
    FOR EACH ROW
    EXECUTE FUNCTION update_service_rating_stats();

CREATE TRIGGER update_service_rating_on_update
    AFTER UPDATE ON service_ratings
    FOR EACH ROW
    EXECUTE FUNCTION update_service_rating_stats();

CREATE TRIGGER update_service_rating_on_delete
    AFTER DELETE ON service_ratings
    FOR EACH ROW
    EXECUTE FUNCTION update_service_rating_stats();

-- ================================
-- VERIFICATION
-- ================================

-- Check that triggers were created successfully
DO $$
DECLARE
    trigger_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO trigger_count
    FROM information_schema.triggers
    WHERE trigger_name IN (
        'update_product_rating_on_insert',
        'update_product_rating_on_update',
        'update_product_rating_on_delete',
        'update_service_rating_on_insert',
        'update_service_rating_on_update',
        'update_service_rating_on_delete'
    );

    IF trigger_count = 6 THEN
        RAISE NOTICE '✅ All 6 rating triggers created successfully!';
    ELSE
        RAISE WARNING '⚠️ Expected 6 triggers, but found %', trigger_count;
    END IF;
END $$;
