-- Migration: Add auction views tracking
-- Description: Create auction_views table and trigger to track unique views per authenticated user

-- ================================
-- AUCTION VIEWS TABLE
-- ================================

CREATE TABLE IF NOT EXISTS auction_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    viewer_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    viewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Prevent duplicate views
    UNIQUE(auction_id, viewer_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_auction_views_auction_id ON auction_views(auction_id);
CREATE INDEX IF NOT EXISTS idx_auction_views_viewer_id ON auction_views(viewer_id);
CREATE INDEX IF NOT EXISTS idx_auction_views_viewed_at ON auction_views(viewed_at DESC);

-- ================================
-- ROW LEVEL SECURITY
-- ================================

ALTER TABLE auction_views ENABLE ROW LEVEL SECURITY;

-- Users can view their own views
CREATE POLICY "Users can view own auction views" ON auction_views
    FOR SELECT USING (auth.uid() = viewer_id);

-- Users can create their own views
CREATE POLICY "Users can create own auction views" ON auction_views
    FOR INSERT WITH CHECK (auth.uid() = viewer_id);

-- Sellers can view all views on their auctions
CREATE POLICY "Sellers can view views on their auctions" ON auction_views
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM auctions
            WHERE auctions.id = auction_views.auction_id
            AND auctions.seller_id = auth.uid()
        )
    );

-- Service role can manage all views
CREATE POLICY "Service role can manage auction views" ON auction_views
    FOR ALL USING (auth.role() = 'service_role');

-- ================================
-- TRIGGER TO UPDATE VIEW COUNT
-- ================================

-- Function to update auction view count
CREATE OR REPLACE FUNCTION update_auction_view_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE auctions
        SET view_count = view_count + 1
        WHERE id = NEW.auction_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE auctions
        SET view_count = view_count - 1
        WHERE id = OLD.auction_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update view count when view is added
DROP TRIGGER IF EXISTS trigger_update_auction_view_count_insert ON auction_views;
CREATE TRIGGER trigger_update_auction_view_count_insert
    AFTER INSERT ON auction_views
    FOR EACH ROW
    EXECUTE FUNCTION update_auction_view_count();

-- Trigger to update view count when view is deleted (cleanup)
DROP TRIGGER IF EXISTS trigger_update_auction_view_count_delete ON auction_views;
CREATE TRIGGER trigger_update_auction_view_count_delete
    AFTER DELETE ON auction_views
    FOR EACH ROW
    EXECUTE FUNCTION update_auction_view_count();

