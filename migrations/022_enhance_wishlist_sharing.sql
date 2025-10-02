-- Migration: Enhance Wishlist with Sharing and Collaboration Features
-- Date: 2025-09-02
-- Description: Add wishlist sharing, friend collaboration, and gift payment functionality

-- ================================
-- WISHLIST SHARES TABLE
-- ================================
-- Track which wishlists are shared with which friends
CREATE TABLE IF NOT EXISTS wishlist_shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    shared_with_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    share_type VARCHAR(20) NOT NULL DEFAULT 'view_and_add' CHECK (share_type IN ('view_only', 'view_and_add')),
    is_active BOOLEAN DEFAULT TRUE,
    shared_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE, -- Optional expiration
    
    -- Metadata
    share_message TEXT, -- Optional message when sharing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Prevent duplicate shares
    UNIQUE(owner_id, shared_with_id)
);

-- ================================
-- WISHLIST COLLABORATIONS TABLE  
-- ================================
-- Track items added by friends to someone else's wishlist
CREATE TABLE IF NOT EXISTS wishlist_collaborations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wishlist_item_id UUID NOT NULL REFERENCES wishlist(id) ON DELETE CASCADE,
    added_by_friend_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    wishlist_owner_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Metadata
    note TEXT, -- Optional note from friend
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Track who added what to whose wishlist
    UNIQUE(wishlist_item_id, added_by_friend_id)
);

-- ================================
-- GIFT ORDERS TABLE
-- ================================
-- Track when friends buy wishlist items as gifts
CREATE TABLE IF NOT EXISTS gift_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    gift_giver_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE, -- Who paid
    gift_recipient_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE, -- Who receives
    wishlist_item_id UUID REFERENCES wishlist(id) ON DELETE SET NULL, -- Original wishlist item
    
    -- Gift details
    gift_message TEXT,
    is_surprise BOOLEAN DEFAULT FALSE, -- If true, recipient doesn't know until delivery
    delivery_address JSONB, -- Where to send the gift
    
    -- Status tracking
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN (
        'pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled'
    )),
    
    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================
-- UPDATE EXISTING WISHLIST TABLE
-- ================================
-- Add metadata columns to existing wishlist table
ALTER TABLE wishlist 
ADD COLUMN IF NOT EXISTS notes TEXT,
ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 1 CHECK (priority BETWEEN 1 AND 5),
ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE, -- For public wishlists
ADD COLUMN IF NOT EXISTS added_by_friend_id UUID REFERENCES user_profiles(id); -- NULL = added by owner

-- Comment on the new column
COMMENT ON COLUMN wishlist.added_by_friend_id IS 'NULL if added by owner, friend_id if added by a friend';
COMMENT ON COLUMN wishlist.priority IS '1=low, 2=normal, 3=medium, 4=high, 5=urgent';

-- ================================
-- INDEXES FOR PERFORMANCE
-- ================================
CREATE INDEX IF NOT EXISTS idx_wishlist_shares_owner ON wishlist_shares(owner_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_shares_shared_with ON wishlist_shares(shared_with_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_shares_active ON wishlist_shares(is_active, owner_id);

CREATE INDEX IF NOT EXISTS idx_wishlist_collaborations_owner ON wishlist_collaborations(wishlist_owner_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_collaborations_friend ON wishlist_collaborations(added_by_friend_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_collaborations_item ON wishlist_collaborations(wishlist_item_id);

CREATE INDEX IF NOT EXISTS idx_gift_orders_giver ON gift_orders(gift_giver_id);
CREATE INDEX IF NOT EXISTS idx_gift_orders_recipient ON gift_orders(gift_recipient_id);
CREATE INDEX IF NOT EXISTS idx_gift_orders_status ON gift_orders(status);
CREATE INDEX IF NOT EXISTS idx_gift_orders_wishlist_item ON gift_orders(wishlist_item_id);

-- ================================
-- ROW LEVEL SECURITY POLICIES
-- ================================

-- Wishlist Shares RLS
ALTER TABLE wishlist_shares ENABLE ROW LEVEL SECURITY;

-- Users can view shares they own or are shared with
CREATE POLICY "Users can view wishlist shares" ON wishlist_shares
    FOR SELECT USING (
        owner_id = auth.uid() OR shared_with_id = auth.uid()
    );

-- Users can create shares for their own wishlists
CREATE POLICY "Users can share their wishlists" ON wishlist_shares
    FOR INSERT WITH CHECK (owner_id = auth.uid());

-- Users can update shares they own
CREATE POLICY "Users can update their wishlist shares" ON wishlist_shares
    FOR UPDATE USING (owner_id = auth.uid());

-- Users can delete shares they own
CREATE POLICY "Users can delete their wishlist shares" ON wishlist_shares
    FOR DELETE USING (owner_id = auth.uid());

-- Wishlist Collaborations RLS  
ALTER TABLE wishlist_collaborations ENABLE ROW LEVEL SECURITY;

-- Users can view collaborations on their wishlists or collaborations they made
CREATE POLICY "Users can view wishlist collaborations" ON wishlist_collaborations
    FOR SELECT USING (
        wishlist_owner_id = auth.uid() OR added_by_friend_id = auth.uid()
    );

-- Friends can add collaborations to shared wishlists
CREATE POLICY "Friends can collaborate on shared wishlists" ON wishlist_collaborations
    FOR INSERT WITH CHECK (
        added_by_friend_id = auth.uid() AND
        EXISTS (
            SELECT 1 FROM wishlist_shares 
            WHERE owner_id = wishlist_owner_id 
            AND shared_with_id = auth.uid() 
            AND is_active = true
            AND share_type = 'view_and_add'
        )
    );

-- Gift Orders RLS
ALTER TABLE gift_orders ENABLE ROW LEVEL SECURITY;

-- Users can view gifts they gave or received
CREATE POLICY "Users can view their gift orders" ON gift_orders
    FOR SELECT USING (
        gift_giver_id = auth.uid() OR gift_recipient_id = auth.uid()
    );

-- Users can create gift orders as givers
CREATE POLICY "Users can create gift orders" ON gift_orders
    FOR INSERT WITH CHECK (gift_giver_id = auth.uid());

-- Users can update gift orders they created
CREATE POLICY "Users can update their gift orders" ON gift_orders
    FOR UPDATE USING (gift_giver_id = auth.uid());

-- ================================
-- UPDATE WISHLIST RLS POLICIES
-- ================================

-- Drop existing restrictive policies and create new ones for collaboration
DROP POLICY IF EXISTS "Users can view their own wishlist items" ON wishlist;
DROP POLICY IF EXISTS "Users can add to their own wishlist" ON wishlist;

-- New policy: Users can view their own wishlist OR shared wishlists
CREATE POLICY "Users can view wishlists" ON wishlist
    FOR SELECT USING (
        user_id = auth.uid() OR -- Own wishlist
        EXISTS ( -- Or shared with them
            SELECT 1 FROM wishlist_shares 
            WHERE owner_id = wishlist.user_id 
            AND shared_with_id = auth.uid() 
            AND is_active = true
        )
    );

-- New policy: Users can add to their own wishlist OR to shared wishlists (if allowed)
CREATE POLICY "Users can add to wishlists" ON wishlist
    FOR INSERT WITH CHECK (
        user_id = auth.uid() OR -- Own wishlist
        (added_by_friend_id = auth.uid() AND -- Added by friend
         EXISTS (
            SELECT 1 FROM wishlist_shares 
            WHERE owner_id = wishlist.user_id 
            AND shared_with_id = auth.uid() 
            AND is_active = true
            AND share_type = 'view_and_add'
        ))
    );

-- Users can only delete their own wishlist items (friends can't remove)
CREATE POLICY "Users can delete own wishlist items" ON wishlist
    FOR DELETE USING (user_id = auth.uid() AND added_by_friend_id IS NULL);

-- ================================
-- FUNCTIONS AND TRIGGERS
-- ================================

-- Function to create collaboration record when friend adds item
CREATE OR REPLACE FUNCTION create_wishlist_collaboration()
RETURNS TRIGGER AS $$
BEGIN
    -- If item was added by a friend (not the owner)
    IF NEW.added_by_friend_id IS NOT NULL AND NEW.added_by_friend_id != NEW.user_id THEN
        INSERT INTO wishlist_collaborations (
            wishlist_item_id,
            added_by_friend_id,
            wishlist_owner_id,
            created_at
        ) VALUES (
            NEW.id,
            NEW.added_by_friend_id,
            NEW.user_id,
            NOW()
        );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically create collaboration records
CREATE TRIGGER create_collaboration_trigger
    AFTER INSERT ON wishlist
    FOR EACH ROW
    EXECUTE FUNCTION create_wishlist_collaboration();

-- Function to update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_wishlist()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Update triggers
CREATE TRIGGER update_wishlist_shares_updated_at
    BEFORE UPDATE ON wishlist_shares
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_wishlist();

CREATE TRIGGER update_gift_orders_updated_at
    BEFORE UPDATE ON gift_orders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_wishlist();

-- ================================
-- VIEWS FOR EASY ACCESS
-- ================================

-- View to get wishlist with collaboration info
CREATE OR REPLACE VIEW wishlist_with_collaborators AS
SELECT 
    w.*,
    CASE 
        WHEN w.added_by_friend_id IS NOT NULL THEN up_friend.username
        ELSE NULL
    END as added_by_friend_name,
    wc.note as collaboration_note,
    p.name as product_name,
    p.price as product_price,
    p.primary_image_url as product_image
FROM wishlist w
LEFT JOIN user_profiles up_friend ON w.added_by_friend_id = up_friend.id
LEFT JOIN wishlist_collaborations wc ON w.id = wc.wishlist_item_id
LEFT JOIN products p ON w.product_id = p.id;

-- View to get shared wishlists with friend info
CREATE OR REPLACE VIEW shared_wishlists AS
SELECT 
    ws.*,
    up_owner.username as owner_username,
    up_owner.username as owner_full_name,
    up_shared.username as shared_with_username,
    up_shared.username as shared_with_full_name
FROM wishlist_shares ws
LEFT JOIN user_profiles up_owner ON ws.owner_id = up_owner.id  
LEFT JOIN user_profiles up_shared ON ws.shared_with_id = up_shared.id;

-- ================================
-- GRANT PERMISSIONS
-- ================================
GRANT SELECT, INSERT, UPDATE, DELETE ON wishlist_shares TO authenticated;
GRANT SELECT, INSERT ON wishlist_collaborations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON gift_orders TO authenticated;
GRANT SELECT ON wishlist_with_collaborators TO authenticated;
GRANT SELECT ON shared_wishlists TO authenticated;

-- Service role needs full access for system operations
GRANT ALL ON wishlist_shares TO service_role;
GRANT ALL ON wishlist_collaborations TO service_role;
GRANT ALL ON gift_orders TO service_role;
GRANT ALL ON wishlist_with_collaborators TO service_role;
GRANT ALL ON shared_wishlists TO service_role;

COMMIT;