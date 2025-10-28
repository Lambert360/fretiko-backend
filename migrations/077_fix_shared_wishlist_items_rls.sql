-- Migration: Fix RLS policies for shared_wishlist_items to allow collaborators
-- Date: 2025-10-22
-- Description: Allow users with 'view_and_add' permission to insert items into shared wishlists

-- ================================
-- DROP EXISTING POLICIES
-- ================================
DROP POLICY IF EXISTS "shared_wishlist_items_insert_policy" ON shared_wishlist_items;
DROP POLICY IF EXISTS "shared_wishlist_items_select_policy" ON shared_wishlist_items;

-- ================================
-- CREATE NEW INSERT POLICY
-- ================================
-- Allows both owners and collaborators with 'view_and_add' permission to insert items
CREATE POLICY "Allow owners and collaborators to insert shared wishlist items"
ON shared_wishlist_items
FOR INSERT
WITH CHECK (
  -- Check if the user is either:
  -- 1. The owner of the wishlist share, OR
  -- 2. A collaborator with 'view_and_add' permission
  EXISTS (
    SELECT 1 FROM wishlist_shares ws
    WHERE ws.id = wishlist_share_id
    AND ws.is_active = true
    AND (
      ws.owner_id = auth.uid()  -- User is the owner
      OR (
        ws.shared_with_id = auth.uid()  -- User is a collaborator
        AND ws.share_type = 'view_and_add'  -- With add permission
      )
    )
  )
);

-- ================================
-- CREATE NEW SELECT POLICY
-- ================================
-- Allows both owners and collaborators to view shared wishlist items
CREATE POLICY "Allow owners and collaborators to view shared wishlist items"
ON shared_wishlist_items
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM wishlist_shares ws
    WHERE ws.id = wishlist_share_id
    AND ws.is_active = true
    AND (
      ws.owner_id = auth.uid()  -- User is the owner
      OR ws.shared_with_id = auth.uid()  -- User is a collaborator
    )
  )
);

-- ================================
-- ENSURE RLS IS ENABLED
-- ================================
ALTER TABLE shared_wishlist_items ENABLE ROW LEVEL SECURITY;

-- ================================
-- VERIFICATION COMMENT
-- ================================
COMMENT ON POLICY "Allow owners and collaborators to insert shared wishlist items" 
ON shared_wishlist_items IS 
'Allows wishlist owners and collaborators with view_and_add permission to insert items into shared_wishlist_items table';

COMMENT ON POLICY "Allow owners and collaborators to view shared wishlist items" 
ON shared_wishlist_items IS 
'Allows wishlist owners and all collaborators to view items in shared_wishlist_items table';

