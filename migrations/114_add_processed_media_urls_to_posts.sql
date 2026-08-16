-- Migration: Add processed_media_urls to posts table
-- Date: 2026-05-29
-- Description: Track processed video URLs for post media

ALTER TABLE posts
ADD COLUMN IF NOT EXISTS processed_media_urls TEXT[] DEFAULT '{}';

COMMENT ON COLUMN posts.processed_media_urls IS 'Array of H.264 converted URLs aligned 1:1 with media_urls';
