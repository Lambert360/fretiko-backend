-- Migration: Add is_verified column to user_profiles
-- Date: 2025-01-28
-- Description: Add verification status for premium/verified stores and users

-- Add is_verified column to user_profiles table
ALTER TABLE user_profiles 
ADD COLUMN is_verified BOOLEAN DEFAULT false;

-- Add index for verified users queries
CREATE INDEX idx_user_profiles_is_verified ON user_profiles(is_verified) WHERE is_verified = true;

-- Add comment for documentation
COMMENT ON COLUMN user_profiles.is_verified IS 'Indicates if the user/store has been verified by Fretiko (green checkmark)';

-- Update RLS policies to allow viewing verified status
-- (Existing policies should already cover this, but being explicit)

-- Grant permissions (users should be able to see verification status)
-- Permissions already handled by existing user_profiles policies

COMMIT;