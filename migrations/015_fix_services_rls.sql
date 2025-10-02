-- Fix services RLS policy to match backend logic
-- Both sellers and riders should be able to create services
-- Run this in Supabase SQL Editor

-- Drop the existing restrictive service creation policy
DROP POLICY IF EXISTS "Providers can create services" ON services;

-- Create new policy that allows both sellers and riders to create services
-- This matches the backend logic: if (!profile?.is_seller && !profile?.is_rider)
CREATE POLICY "Sellers and riders can create services" ON services
    FOR INSERT WITH CHECK (
        user_id = auth.uid() 
        AND EXISTS (
            SELECT 1 FROM user_profiles 
            WHERE id = auth.uid() 
            AND (is_seller = true OR is_rider = true)
        )
    );