-- Migration: Debug and fix shared_wishlist_items RLS policies
-- Date: 2025-10-22
-- Description: Drop all policies and recreate with proper logic

-- ================================
-- DROP ALL EXISTING POLICIES
-- ================================
DROP POLICY IF EXISTS "Allow owners and collaborators to insert shared wishlist items" ON shared_wishlist_items;
DROP POLICY IF EXISTS "Allow owners and collaborators to view shared wishlist items" ON shared_wishlist_items;
DROP POLICY IF EXISTS "shared_wishlist_items_insert_policy" ON shared_wishlist_items;
DROP POLICY IF EXISTS "shared_wishlist_items_select_policy" ON shared_wishlist_items;
DROP POLICY IF EXISTS "shared_wishlist_items_insert" ON shared_wishlist_items;
DROP POLICY IF EXISTS "shared_wishlist_items_select" ON shared_wishlist_items;

-- ================================
-- TEMPORARILY DISABLE RLS FOR TESTING
-- ================================
-- This will help us understand if RLS is the issue
ALTER TABLE shared_wishlist_items DISABLE ROW LEVEL SECURITY;

-- ================================
-- RE-ENABLE RLS WITH NEW POLICIES
-- ================================
ALTER TABLE shared_wishlist_items ENABLE ROW LEVEL SECURITY;

-- ================================
-- CREATE PERMISSIVE INSERT POLICY
-- ================================
-- Allow authenticated users to insert if they have a valid share relationship
CREATE POLICY "shared_wishlist_items_insert_v2"
ON shared_wishlist_items
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM wishlist_shares ws
    WHERE ws.id = wishlist_share_id
    AND ws.is_active = true
    AND (
      ws.owner_id = auth.uid()
      OR (
        ws.shared_with_id = auth.uid()
        AND ws.share_type = 'view_and_add'
      )
    )
  )
);

-- ================================
-- CREATE PERMISSIVE SELECT POLICY
-- ================================
-- Allow authenticated users to select if they have a valid share relationship
CREATE POLICY "shared_wishlist_items_select_v2"
ON shared_wishlist_items
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM wishlist_shares ws
    WHERE ws.id = wishlist_share_id
    AND ws.is_active = true
    AND (
      ws.owner_id = auth.uid()
      OR ws.shared_with_id = auth.uid()
    )
  )
);

-- ================================
-- VERIFICATION QUERIES
-- ================================
-- Run these to verify the policies are working:

-- Check existing policies
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE tablename = 'shared_wishlist_items';

-- Check if RLS is enabled
SELECT tablename, rowsecurity
FROM pg_tables
WHERE tablename = 'shared_wishlist_items';

