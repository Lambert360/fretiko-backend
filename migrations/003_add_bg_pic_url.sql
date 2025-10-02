-- Migration: Add background picture URL and is_rider to user_profiles
-- Date: 2025-08-27
-- Description: Add bg_pic_url column for profile background images and is_rider for rider role

-- Add background picture URL column
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS bg_pic_url TEXT;

-- Add is_rider column (you mentioned you created this, but just in case)
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS is_rider BOOLEAN DEFAULT FALSE;

-- Create index for bg_pic_url for better performance when querying profiles with background images
CREATE INDEX IF NOT EXISTS user_profiles_bg_pic_url_idx ON user_profiles(bg_pic_url) WHERE bg_pic_url IS NOT NULL;

-- Create index for is_rider for better performance when filtering riders
CREATE INDEX IF NOT EXISTS user_profiles_is_rider_idx ON user_profiles(is_rider) WHERE is_rider = TRUE;

-- Create composite index for sellers and riders
CREATE INDEX IF NOT EXISTS user_profiles_seller_rider_idx ON user_profiles(is_seller, is_rider);

COMMIT;