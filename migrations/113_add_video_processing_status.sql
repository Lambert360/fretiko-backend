-- Migration: Add video processing status columns
-- Date: 2026-05-29
-- Description: Track video conversion status on services, products, and post_media so processed H.264 URLs can be served to clients

-- ================================
-- SERVICES TABLE
-- ================================
ALTER TABLE services
ADD COLUMN IF NOT EXISTS processed_videos TEXT[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS video_processing_status JSONB DEFAULT '{}';

COMMENT ON COLUMN services.processed_videos IS 'Array of H.264 converted video URLs, aligned 1:1 with the videos array';
COMMENT ON COLUMN services.video_processing_status IS 'Per-index processing status: { "0": {"status":"completed","jobId":"...","processedUrl":"..."} }';

-- ================================
-- PRODUCTS TABLE
-- ================================
ALTER TABLE products
ADD COLUMN IF NOT EXISTS processed_videos TEXT[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS video_processing_status JSONB DEFAULT '{}';

COMMENT ON COLUMN products.processed_videos IS 'Array of H.264 converted video URLs, aligned 1:1 with the videos array';
COMMENT ON COLUMN products.video_processing_status IS 'Per-index processing status: { "0": {"status":"completed","jobId":"...","processedUrl":"..."} }';

-- ================================
-- POST_MEDIA TABLE
-- ================================
ALTER TABLE post_media
ADD COLUMN IF NOT EXISTS processed_url TEXT,
ADD COLUMN IF NOT EXISTS processing_status TEXT DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed'));

COMMENT ON COLUMN post_media.processed_url IS 'H.264 converted URL for video media items';
COMMENT ON COLUMN post_media.processing_status IS 'Conversion status for this media item';

-- Create index for quickly finding pending/failed processing jobs
CREATE INDEX IF NOT EXISTS idx_post_media_processing_status ON post_media(processing_status) WHERE media_type = 'video';
