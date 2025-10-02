-- Debug script to check user profiles
-- Run this in Supabase SQL Editor to see what's happening

-- 1. Check if users exist in auth.users
SELECT id, email, created_at FROM auth.users ORDER BY created_at DESC LIMIT 5;

-- 2. Check if profiles were created in user_profiles  
SELECT id, username, created_at FROM user_profiles ORDER BY created_at DESC LIMIT 5;

-- 3. Check if the trigger function exists
SELECT proname FROM pg_proc WHERE proname = 'handle_new_user';

-- 4. Check if the trigger exists
SELECT tgname FROM pg_trigger WHERE tgname = 'on_auth_user_created';

-- 5. Manually create missing profiles (if needed)
-- Uncomment and run this if profiles are missing:
/*
INSERT INTO user_profiles (id, username)
SELECT 
    id,
    LOWER(SPLIT_PART(email, '@', 1)) as username
FROM auth.users 
WHERE NOT EXISTS (
    SELECT 1 FROM user_profiles WHERE user_profiles.id = auth.users.id
);
*/