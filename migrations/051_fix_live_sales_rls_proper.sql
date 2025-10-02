-- Fix live_streams RLS to allow any seller/vendor to create streams
-- This is the proper MVP approach - open to all vendors

BEGIN;

-- Drop the existing restrictive policy
DROP POLICY IF EXISTS "Vendors can manage their own streams" ON live_streams;
DROP POLICY IF EXISTS "Authenticated users can manage their own streams" ON live_streams;

-- Create proper policy: Any user with is_seller=true OR user_role='vendor' can create streams
CREATE POLICY "Sellers and vendors can manage their own streams" ON live_streams
FOR ALL USING (
    auth.uid() = vendor_id AND
    EXISTS (
        SELECT 1 FROM user_profiles
        WHERE id = auth.uid()
        AND (is_seller = true OR user_role = 'vendor')
    )
);

-- Also update your specific user to be a vendor
UPDATE user_profiles
SET user_role = 'vendor', is_seller = true
WHERE id = '27ae3125-2dd7-4266-850f-0c5387617713';

COMMIT;