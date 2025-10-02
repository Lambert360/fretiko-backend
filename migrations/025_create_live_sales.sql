-- Migration: Create Live Sales System
-- Date: 2025-01-28
-- Description: Complete live streaming system with real-time features, commerce, and analytics

-- ================================
-- LIVE STREAMS TABLE
-- ================================

CREATE TABLE live_streams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    stream_type VARCHAR(20) NOT NULL CHECK (stream_type IN ('products', 'services')),
    status VARCHAR(20) NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'live', 'ended', 'paused')),
    viewer_count INTEGER DEFAULT 0,
    total_viewers INTEGER DEFAULT 0,
    total_sales DECIMAL(10,2) DEFAULT 0,
    thumbnail_url TEXT,
    stream_url TEXT,
    started_at TIMESTAMP WITH TIME ZONE,
    ended_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================
-- LIVE STREAM PRODUCTS TABLE
-- ================================

CREATE TABLE live_stream_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    live_price DECIMAL(10,2) NOT NULL CHECK (live_price >= 0),
    live_stock INTEGER NOT NULL CHECK (live_stock >= 0),
    original_stock INTEGER NOT NULL CHECK (original_stock >= 0),
    sold_count INTEGER DEFAULT 0 CHECK (sold_count >= 0),
    display_order INTEGER DEFAULT 0,
    is_featured BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(stream_id, product_id)
);

-- ================================
-- LIVE STREAM SERVICES TABLE
-- ================================

CREATE TABLE live_stream_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
    service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    live_price DECIMAL(10,2) NOT NULL CHECK (live_price >= 0),
    available_slots JSONB DEFAULT '[]',
    booking_window_days INTEGER DEFAULT 30 CHECK (booking_window_days > 0),
    max_advance_days INTEGER DEFAULT 90 CHECK (max_advance_days > 0),
    display_order INTEGER DEFAULT 0,
    is_featured BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(stream_id, service_id)
);

-- ================================
-- LIVE STREAM VIEWERS TABLE
-- ================================

CREATE TABLE live_stream_viewers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    left_at TIMESTAMP WITH TIME ZONE,
    total_watch_time INTEGER DEFAULT 0 CHECK (total_watch_time >= 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(stream_id, user_id)
);

-- ================================
-- LIVE STREAM COMMENTS TABLE
-- ================================

CREATE TABLE live_stream_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    is_pinned BOOLEAN DEFAULT false,
    is_deleted BOOLEAN DEFAULT false,
    deleted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================
-- LIVE STREAM REACTIONS TABLE
-- ================================

CREATE TABLE live_stream_reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    reaction_type VARCHAR(20) NOT NULL CHECK (reaction_type IN ('like', 'heart', 'fire', 'clap', 'wow')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(stream_id, user_id, reaction_type)
);

-- ================================
-- GIFT TYPES CONFIGURATION TABLE
-- ================================

CREATE TABLE gift_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) UNIQUE NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    icon_name VARCHAR(50) NOT NULL,
    base_value DECIMAL(10,2) NOT NULL CHECK (base_value > 0),
    color VARCHAR(7) NOT NULL,
    animation_type VARCHAR(30),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================
-- LIVE STREAM GIFTS TABLE
-- ================================

CREATE TABLE live_stream_gifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    receiver_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    gift_type VARCHAR(50) NOT NULL REFERENCES gift_types(name),
    gift_value DECIMAL(10,2) NOT NULL CHECK (gift_value > 0),
    quantity INTEGER DEFAULT 1 CHECK (quantity > 0),
    total_amount DECIMAL(10,2) NOT NULL CHECK (total_amount > 0),
    message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================
-- LIVE STREAM TRANSACTIONS TABLE
-- ================================

CREATE TABLE live_stream_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
    buyer_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    vendor_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    transaction_type VARCHAR(20) NOT NULL CHECK (transaction_type IN ('product', 'service')),
    
    -- For product purchases
    product_id UUID REFERENCES products(id),
    quantity INTEGER CHECK (quantity > 0),
    unit_price DECIMAL(10,2) CHECK (unit_price >= 0),
    
    -- For service bookings
    service_id UUID REFERENCES services(id),
    service_date DATE,
    service_time TIME,
    service_notes TEXT,
    
    -- Common fields
    total_amount DECIMAL(10,2) NOT NULL CHECK (total_amount >= 0),
    platform_fee DECIMAL(10,2) DEFAULT 0 CHECK (platform_fee >= 0),
    rider_fee DECIMAL(10,2) DEFAULT 0 CHECK (rider_fee >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'escrow', 'completed', 'cancelled', 'refunded')),
    
    -- Delivery details (leveraging existing is_rider column in user_profiles)
    rider_id UUID REFERENCES user_profiles(id),
    delivery_address JSONB,
    continue_watching BOOLEAN DEFAULT false,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Ensure transaction type matches the related fields
    CONSTRAINT valid_product_transaction CHECK (
        (transaction_type = 'product' AND product_id IS NOT NULL AND quantity IS NOT NULL AND unit_price IS NOT NULL) OR
        (transaction_type = 'service' AND service_id IS NOT NULL)
    )
);

-- ================================
-- LIVE STREAM ANALYTICS TABLE
-- ================================

CREATE TABLE live_stream_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
    metric_type VARCHAR(50) NOT NULL,
    metric_value INTEGER DEFAULT 1,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================
-- INDEXES FOR PERFORMANCE
-- ================================

-- Live streams indexes
CREATE INDEX idx_live_streams_vendor_id ON live_streams(vendor_id);
CREATE INDEX idx_live_streams_status ON live_streams(status);
CREATE INDEX idx_live_streams_stream_type ON live_streams(stream_type);
CREATE INDEX idx_live_streams_created_at ON live_streams(created_at DESC);
CREATE INDEX idx_live_streams_started_at ON live_streams(started_at DESC);

-- Live stream products indexes
CREATE INDEX idx_live_stream_products_stream_id ON live_stream_products(stream_id);
CREATE INDEX idx_live_stream_products_product_id ON live_stream_products(product_id);
CREATE INDEX idx_live_stream_products_featured ON live_stream_products(is_featured) WHERE is_featured = true;

-- Live stream services indexes
CREATE INDEX idx_live_stream_services_stream_id ON live_stream_services(stream_id);
CREATE INDEX idx_live_stream_services_service_id ON live_stream_services(service_id);
CREATE INDEX idx_live_stream_services_featured ON live_stream_services(is_featured) WHERE is_featured = true;

-- Viewers indexes
CREATE INDEX idx_live_stream_viewers_stream_id ON live_stream_viewers(stream_id);
CREATE INDEX idx_live_stream_viewers_user_id ON live_stream_viewers(user_id);
CREATE INDEX idx_live_stream_viewers_active ON live_stream_viewers(stream_id, user_id) WHERE left_at IS NULL;

-- Comments indexes
CREATE INDEX idx_live_stream_comments_stream_id ON live_stream_comments(stream_id);
CREATE INDEX idx_live_stream_comments_user_id ON live_stream_comments(user_id);
CREATE INDEX idx_live_stream_comments_created_at ON live_stream_comments(created_at DESC);
CREATE INDEX idx_live_stream_comments_pinned ON live_stream_comments(stream_id, is_pinned) WHERE is_pinned = true;

-- Reactions indexes
CREATE INDEX idx_live_stream_reactions_stream_id ON live_stream_reactions(stream_id);
CREATE INDEX idx_live_stream_reactions_user_id ON live_stream_reactions(user_id);

-- Gifts indexes
CREATE INDEX idx_live_stream_gifts_stream_id ON live_stream_gifts(stream_id);
CREATE INDEX idx_live_stream_gifts_sender_id ON live_stream_gifts(sender_id);
CREATE INDEX idx_live_stream_gifts_receiver_id ON live_stream_gifts(receiver_id);
CREATE INDEX idx_live_stream_gifts_created_at ON live_stream_gifts(created_at DESC);

-- Transactions indexes
CREATE INDEX idx_live_stream_transactions_stream_id ON live_stream_transactions(stream_id);
CREATE INDEX idx_live_stream_transactions_buyer_id ON live_stream_transactions(buyer_id);
CREATE INDEX idx_live_stream_transactions_vendor_id ON live_stream_transactions(vendor_id);
CREATE INDEX idx_live_stream_transactions_status ON live_stream_transactions(status);
CREATE INDEX idx_live_stream_transactions_rider_id ON live_stream_transactions(rider_id) WHERE rider_id IS NOT NULL;

-- Analytics indexes
CREATE INDEX idx_live_stream_analytics_stream_id ON live_stream_analytics(stream_id);
CREATE INDEX idx_live_stream_analytics_metric_type ON live_stream_analytics(metric_type);
CREATE INDEX idx_live_stream_analytics_created_at ON live_stream_analytics(created_at DESC);

-- Gift types indexes
CREATE INDEX idx_gift_types_active ON gift_types(is_active) WHERE is_active = true;

-- ================================
-- VIEWS FOR EASY QUERYING
-- ================================

CREATE VIEW live_stream_stats AS
SELECT 
    ls.id,
    ls.vendor_id,
    ls.title,
    ls.description,
    ls.stream_type,
    ls.status,
    ls.viewer_count,
    ls.total_viewers,
    ls.total_sales,
    COUNT(DISTINCT lsv.user_id) FILTER (WHERE lsv.left_at IS NULL) as current_viewers,
    COUNT(DISTINCT lsc.id) FILTER (WHERE lsc.is_deleted = false) as total_comments,
    COUNT(DISTINCT lsr.id) as total_reactions,
    COUNT(DISTINCT lsg.id) as total_gifts,
    COALESCE(SUM(lsg.total_amount), 0) as total_gift_value,
    COUNT(DISTINCT lst.id) as total_transactions,
    ls.thumbnail_url,
    ls.stream_url,
    ls.created_at,
    ls.started_at,
    ls.ended_at
FROM live_streams ls
LEFT JOIN live_stream_viewers lsv ON ls.id = lsv.stream_id
LEFT JOIN live_stream_comments lsc ON ls.id = lsc.stream_id
LEFT JOIN live_stream_reactions lsr ON ls.id = lsr.stream_id
LEFT JOIN live_stream_gifts lsg ON ls.id = lsg.stream_id
LEFT JOIN live_stream_transactions lst ON ls.id = lst.stream_id
GROUP BY ls.id, ls.vendor_id, ls.title, ls.description, ls.stream_type, ls.status, 
         ls.viewer_count, ls.total_viewers, ls.total_sales, ls.thumbnail_url, 
         ls.stream_url, ls.created_at, ls.started_at, ls.ended_at;

-- ================================
-- FUNCTIONS AND TRIGGERS
-- ================================

-- Function to update stream viewer count
CREATE OR REPLACE FUNCTION update_stream_viewer_count()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE live_streams 
    SET 
        viewer_count = (
            SELECT COUNT(*) 
            FROM live_stream_viewers 
            WHERE stream_id = COALESCE(NEW.stream_id, OLD.stream_id) 
            AND left_at IS NULL
        ),
        total_viewers = (
            SELECT COUNT(DISTINCT user_id)
            FROM live_stream_viewers 
            WHERE stream_id = COALESCE(NEW.stream_id, OLD.stream_id)
        ),
        updated_at = NOW()
    WHERE id = COALESCE(NEW.stream_id, OLD.stream_id);
    
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Function to update stream sales total
CREATE OR REPLACE FUNCTION update_stream_sales_total()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE live_streams 
    SET 
        total_sales = (
            SELECT COALESCE(SUM(total_amount), 0)
            FROM live_stream_transactions 
            WHERE stream_id = COALESCE(NEW.stream_id, OLD.stream_id)
            AND status IN ('paid', 'completed')
        ),
        updated_at = NOW()
    WHERE id = COALESCE(NEW.stream_id, OLD.stream_id);
    
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Apply timestamp triggers
CREATE TRIGGER update_live_streams_updated_at BEFORE UPDATE ON live_streams FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_live_stream_products_updated_at BEFORE UPDATE ON live_stream_products FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_live_stream_services_updated_at BEFORE UPDATE ON live_stream_services FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_live_stream_comments_updated_at BEFORE UPDATE ON live_stream_comments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_gift_types_updated_at BEFORE UPDATE ON gift_types FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_live_stream_transactions_updated_at BEFORE UPDATE ON live_stream_transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Viewer count triggers
CREATE TRIGGER update_viewer_count_on_join
    AFTER INSERT ON live_stream_viewers
    FOR EACH ROW EXECUTE FUNCTION update_stream_viewer_count();

CREATE TRIGGER update_viewer_count_on_leave
    AFTER UPDATE ON live_stream_viewers
    FOR EACH ROW EXECUTE FUNCTION update_stream_viewer_count();

-- Sales total triggers
CREATE TRIGGER update_sales_total_on_transaction
    AFTER INSERT OR UPDATE ON live_stream_transactions
    FOR EACH ROW EXECUTE FUNCTION update_stream_sales_total();

-- ================================
-- ROW LEVEL SECURITY (RLS)
-- ================================

-- Enable RLS on all tables
ALTER TABLE live_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_stream_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_stream_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_stream_viewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_stream_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_stream_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_stream_gifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_stream_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_stream_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE gift_types ENABLE ROW LEVEL SECURITY;

-- Live streams policies
CREATE POLICY "Anyone can view live streams" ON live_streams FOR SELECT USING (true);
CREATE POLICY "Vendors can manage their own streams" ON live_streams FOR ALL USING (auth.uid() = vendor_id);

-- Live stream products policies
CREATE POLICY "Anyone can view stream products" ON live_stream_products FOR SELECT USING (true);
CREATE POLICY "Vendors can manage their stream products" ON live_stream_products FOR ALL USING (
    EXISTS (SELECT 1 FROM live_streams WHERE id = stream_id AND vendor_id = auth.uid())
);

-- Live stream services policies
CREATE POLICY "Anyone can view stream services" ON live_stream_services FOR SELECT USING (true);
CREATE POLICY "Vendors can manage their stream services" ON live_stream_services FOR ALL USING (
    EXISTS (SELECT 1 FROM live_streams WHERE id = stream_id AND vendor_id = auth.uid())
);

-- Viewers policies
CREATE POLICY "Anyone can view stream viewers" ON live_stream_viewers FOR SELECT USING (true);
CREATE POLICY "Users can manage their own viewer records" ON live_stream_viewers FOR ALL USING (auth.uid() = user_id);

-- Comments policies
CREATE POLICY "Anyone can view stream comments" ON live_stream_comments FOR SELECT USING (is_deleted = false);
CREATE POLICY "Users can manage their own comments" ON live_stream_comments FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Stream vendors can manage comments on their streams" ON live_stream_comments FOR UPDATE USING (
    EXISTS (SELECT 1 FROM live_streams WHERE id = stream_id AND vendor_id = auth.uid())
);

-- Reactions policies
CREATE POLICY "Anyone can view stream reactions" ON live_stream_reactions FOR SELECT USING (true);
CREATE POLICY "Users can manage their own reactions" ON live_stream_reactions FOR ALL USING (auth.uid() = user_id);

-- Gifts policies
CREATE POLICY "Anyone can view stream gifts" ON live_stream_gifts FOR SELECT USING (true);
CREATE POLICY "Users can send gifts" ON live_stream_gifts FOR INSERT WITH CHECK (auth.uid() = sender_id);
CREATE POLICY "Users can view their sent/received gifts" ON live_stream_gifts FOR SELECT USING (
    auth.uid() = sender_id OR auth.uid() = receiver_id
);

-- Transactions policies
CREATE POLICY "Users can view their own transactions" ON live_stream_transactions FOR SELECT USING (
    auth.uid() = buyer_id OR auth.uid() = vendor_id OR auth.uid() = rider_id
);
CREATE POLICY "Users can create their own transactions" ON live_stream_transactions FOR INSERT WITH CHECK (auth.uid() = buyer_id);
CREATE POLICY "Vendors and riders can update relevant transactions" ON live_stream_transactions FOR UPDATE USING (
    auth.uid() = vendor_id OR auth.uid() = rider_id
);

-- Analytics policies (vendors only)
CREATE POLICY "Vendors can view their stream analytics" ON live_stream_analytics FOR SELECT USING (
    EXISTS (SELECT 1 FROM live_streams WHERE id = stream_id AND vendor_id = auth.uid())
);
CREATE POLICY "System can insert analytics" ON live_stream_analytics FOR INSERT WITH CHECK (true);

-- Gift types policies
CREATE POLICY "Anyone can view active gift types" ON gift_types FOR SELECT USING (is_active = true);

-- ================================
-- INITIAL DATA
-- ================================

-- Insert default gift types
INSERT INTO gift_types (name, display_name, icon_name, base_value, color) VALUES
('heart', 'Heart', 'heart', 1.00, '#FF4757'),
('coin', 'Coin', 'cash', 5.00, '#FFD700'),
('diamond', 'Diamond', 'diamond', 10.00, '#00D2FF'),
('rocket', 'Rocket', 'rocket', 20.00, '#FF6B6B'),
('crown', 'Crown', 'crown', 50.00, '#9C88FF'),
('star', 'Star', 'star', 100.00, '#FFA726')
ON CONFLICT (name) DO NOTHING;

-- ================================
-- GRANT PERMISSIONS
-- ================================

-- Grant permissions to authenticated users
GRANT SELECT, INSERT, UPDATE, DELETE ON live_streams TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON live_stream_products TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON live_stream_services TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON live_stream_viewers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON live_stream_comments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON live_stream_reactions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON live_stream_gifts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON live_stream_transactions TO authenticated;
GRANT SELECT, INSERT ON live_stream_analytics TO authenticated;
GRANT SELECT ON gift_types TO authenticated;

-- Grant view access
GRANT SELECT ON live_stream_stats TO authenticated;

-- Service role needs full access for system operations
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Add comment for documentation
COMMENT ON TABLE live_streams IS 'Main table for live streaming sessions with vendor information and stream metadata';
COMMENT ON TABLE live_stream_products IS 'Products featured in live streams with special pricing and stock management';
COMMENT ON TABLE live_stream_services IS 'Services offered in live streams with booking capabilities';
COMMENT ON TABLE live_stream_viewers IS 'Tracks users watching live streams for analytics and engagement';
COMMENT ON TABLE live_stream_comments IS 'Real-time comments during live streams';
COMMENT ON TABLE live_stream_reactions IS 'User reactions (likes, hearts, etc.) during live streams';
COMMENT ON TABLE live_stream_gifts IS 'Virtual gifts sent during live streams with monetary value';
COMMENT ON TABLE live_stream_transactions IS 'Live commerce transactions for products and services';
COMMENT ON TABLE live_stream_analytics IS 'Analytics data for live stream performance tracking';
COMMENT ON TABLE gift_types IS 'Configuration for available virtual gifts';

COMMIT;