-- Fix live_streams RLS to be open to all sellers/vendors
-- MVP approach: Allow any user with is_seller=true OR user_role='vendor' to create streams

BEGIN;

-- Drop existing restrictive policies
DROP POLICY IF EXISTS "Vendors can manage their own streams" ON live_streams;
DROP POLICY IF EXISTS "Authenticated users can manage their own streams" ON live_streams;
DROP POLICY IF EXISTS "Sellers and vendors can manage their own streams" ON live_streams;

-- Create open policy for all sellers and vendors
CREATE POLICY "Open access for sellers and vendors" ON live_streams
FOR ALL USING (
    auth.uid() = vendor_id AND
    EXISTS (
        SELECT 1 FROM user_profiles
        WHERE id = auth.uid()
        AND (is_seller = true OR user_role = 'vendor')
    )
);

-- Ensure RLS is enabled
ALTER TABLE live_streams ENABLE ROW LEVEL SECURITY;

COMMIT;