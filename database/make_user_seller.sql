-- Quick script to make any user a seller for testing
-- Replace 'YOUR_USER_ID' with your actual user ID from the app logs

-- Update user to be a seller (replace with your actual user ID)
UPDATE user_profiles
SET
  is_seller = true,
  user_role = 'vendor',
  updated_at = NOW()
WHERE id = 'YOUR_USER_ID';

-- Check the result
SELECT id, username, user_role, is_seller, created_at
FROM user_profiles
WHERE id = 'YOUR_USER_ID';