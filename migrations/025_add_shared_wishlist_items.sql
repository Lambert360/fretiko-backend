-- Migration: Add Selective Wishlist Item Sharing
-- Date: 2025-01-14
-- Description: Add table to track which specific wishlist items are shared with each person

-- ================================
-- SHARED WISHLIST ITEMS TABLE
-- ================================
-- Track individual items shared (not entire wishlist)
CREATE TABLE IF NOT EXISTS shared_wishlist_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wishlist_share_id UUID NOT NULL REFERENCES wishlist_shares(id) ON DELETE CASCADE,
    wishlist_item_id UUID NOT NULL REFERENCES wishlist(id) ON DELETE CASCADE,

    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Prevent duplicate item shares within same share
    UNIQUE(wishlist_share_id, wishlist_item_id)
);

-- ================================
-- INDEXES FOR PERFORMANCE
-- ================================
CREATE INDEX IF NOT EXISTS idx_shared_wishlist_items_share ON shared_wishlist_items(wishlist_share_id);
CREATE INDEX IF NOT EXISTS idx_shared_wishlist_items_item ON shared_wishlist_items(wishlist_item_id);

-- ================================
-- ROW LEVEL SECURITY POLICIES
-- ================================
ALTER TABLE shared_wishlist_items ENABLE ROW LEVEL SECURITY;

-- Users can view shared items if they are the owner or recipient of the share
CREATE POLICY "Users can view shared wishlist items" ON shared_wishlist_items
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM wishlist_shares ws
            WHERE ws.id = wishlist_share_id
            AND (ws.owner_id = auth.uid() OR ws.shared_with_id = auth.uid())
        )
    );

-- Users can add items to their own shares
CREATE POLICY "Users can share their wishlist items" ON shared_wishlist_items
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM wishlist_shares ws
            WHERE ws.id = wishlist_share_id
            AND ws.owner_id = auth.uid()
        )
    );

-- Users can delete shared items from their own shares
CREATE POLICY "Users can delete their shared wishlist items" ON shared_wishlist_items
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM wishlist_shares ws
            WHERE ws.id = wishlist_share_id
            AND ws.owner_id = auth.uid()
        )
    );

-- ================================
-- VIEW FOR EASY ACCESS
-- ================================
-- View to get shared wishlist items with product details
CREATE OR REPLACE VIEW shared_wishlist_items_with_details AS
SELECT
    swi.*,
    ws.owner_id,
    ws.shared_with_id,
    ws.share_type,
    ws.is_active,
    w.user_id as wishlist_owner_id,
    w.product_id,
    w.notes,
    w.priority,
    p.name as product_name,
    p.price as product_price,
    p.primary_image_url as product_image,
    p.status as product_status,
    p.user_id as seller_id,
    up_owner.username as owner_username,
    up_shared.username as shared_with_username
FROM shared_wishlist_items swi
INNER JOIN wishlist_shares ws ON swi.wishlist_share_id = ws.id
INNER JOIN wishlist w ON swi.wishlist_item_id = w.id
INNER JOIN products p ON w.product_id = p.id
LEFT JOIN user_profiles up_owner ON ws.owner_id = up_owner.id
LEFT JOIN user_profiles up_shared ON ws.shared_with_id = up_shared.id;

-- ================================
-- GRANT PERMISSIONS
-- ================================
GRANT SELECT, INSERT, DELETE ON shared_wishlist_items TO authenticated;
GRANT SELECT ON shared_wishlist_items_with_details TO authenticated;

-- Service role needs full access
GRANT ALL ON shared_wishlist_items TO service_role;
GRANT ALL ON shared_wishlist_items_with_details TO service_role;

COMMIT;
