-- Migration: Add video support to products table
-- Date: 2025-10-12
-- Description: Add video columns to products table for TikTok-style product videos

-- Add video columns to products table
ALTER TABLE products
ADD COLUMN IF NOT EXISTS videos TEXT[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS primary_video_url TEXT,
ADD COLUMN IF NOT EXISTS media_type VARCHAR(10) DEFAULT 'image' CHECK (media_type IN ('image', 'video'));

-- Create index for media type queries (to filter video products easily)
CREATE INDEX IF NOT EXISTS idx_products_media_type ON products(media_type);

-- Add comment for documentation
COMMENT ON COLUMN products.videos IS 'Array of video URLs for TikTok-style product videos';
COMMENT ON COLUMN products.primary_video_url IS 'Primary video URL to display';
COMMENT ON COLUMN products.media_type IS 'Primary media type: image (photo products) or video (video products)';
