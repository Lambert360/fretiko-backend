-- Fix for live_streams RLS policy and user profile issues
-- This ensures the test user exists and has proper permissions

BEGIN;

-- First, ensure the test user exists in user_profiles
INSERT INTO user_profiles (
    id,
    email,
    first_name,
    last_name,
    username,
    user_role,
    is_seller,
    created_at,
    updated_at
) VALUES (
    '27ae3125-2dd7-4266-850f-0c5387617713',
    'ezinne@fretiko.com',
    'Ezinne',
    'H',
    'ezinne_vendor',
    'vendor',
    true,
    NOW(),
    NOW()
) ON CONFLICT (id) DO UPDATE SET
    user_role = 'vendor',
    is_seller = true,
    updated_at = NOW();

-- Drop the existing restrictive policy
DROP POLICY IF EXISTS "Vendors can manage their own streams" ON live_streams;

-- Create a more permissive policy that allows any authenticated user to create streams
CREATE POLICY "Authenticated users can manage their own streams" ON live_streams
    FOR ALL USING (auth.uid() = vendor_id);

-- Ensure RLS is enabled
ALTER TABLE live_streams ENABLE ROW LEVEL SECURITY;

COMMIT;