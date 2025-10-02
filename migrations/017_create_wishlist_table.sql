-- Migration: Create Wishlist Table
-- Date: 2025-01-01  
-- Description: Create wishlist table for users to save favorite products

-- ================================
-- WISHLIST TABLE
-- ================================

CREATE TABLE IF NOT EXISTS wishlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, product_id)
);

-- ================================
-- INDEXES FOR PERFORMANCE
-- ================================

CREATE INDEX IF NOT EXISTS idx_wishlist_user_id ON wishlist(user_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_product_id ON wishlist(product_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_created_at ON wishlist(created_at DESC);

-- ================================
-- ROW LEVEL SECURITY POLICIES
-- ================================

-- Enable RLS on wishlist table
ALTER TABLE wishlist ENABLE ROW LEVEL SECURITY;

-- Users can only see their own wishlist items
CREATE POLICY "Users can view their own wishlist items" ON wishlist
    FOR SELECT USING (user_id = auth.uid());

-- Users can add items to their own wishlist
CREATE POLICY "Users can add to their own wishlist" ON wishlist
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- Users can delete their own wishlist items
CREATE POLICY "Users can delete their own wishlist items" ON wishlist
    FOR DELETE USING (user_id = auth.uid());

-- Grant permissions
GRANT SELECT, INSERT, DELETE ON wishlist TO authenticated;
GRANT ALL ON wishlist TO service_role;

COMMIT;