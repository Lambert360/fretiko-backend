-- Migration: Add average_rating and review_count to products table
-- Date: 2025-01-29
-- Description: Add columns to store aggregated rating data for products

-- Add average_rating and review_count columns to products table
ALTER TABLE products
ADD COLUMN IF NOT EXISTS average_rating DECIMAL(3,2) DEFAULT 0 CHECK (average_rating >= 0 AND average_rating <= 5),
ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0 CHECK (review_count >= 0);

-- Add similar columns to services table for consistency
ALTER TABLE services
ADD COLUMN IF NOT EXISTS average_rating DECIMAL(3,2) DEFAULT 0 CHECK (average_rating >= 0 AND average_rating <= 5),
ADD COLUMN IF NOT EXISTS review_count INTEGER DEFAULT 0 CHECK (review_count >= 0);

-- Create indexes for performance when filtering/sorting by rating
CREATE INDEX IF NOT EXISTS idx_products_average_rating ON products(average_rating DESC) WHERE average_rating > 0;
CREATE INDEX IF NOT EXISTS idx_services_average_rating ON services(average_rating DESC) WHERE average_rating > 0;

-- Update existing products with their current ratings
-- This will calculate and populate the rating data for existing products
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

-- Update existing services with their current ratings
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
