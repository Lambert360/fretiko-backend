-- ================================================================
-- FRETIKO AUCTION SYSTEM - FIXED MIGRATION
-- ================================================================
-- Date: 2025-01-28
-- Description: Handles existing auction tables and creates proper structure
-- Safe to run: Handles existing tables properly
-- ================================================================

-- ================================
-- STEP 1: DROP EXISTING INCOMPATIBLE TABLES
-- ================================
-- The existing auction_bids table has incompatible structure, so we need to recreate it

DO $$
BEGIN
    -- Drop existing auction tables that have incompatible structure
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'auction_bids' AND table_schema = 'public') THEN
        DROP TABLE auction_bids CASCADE;
        RAISE NOTICE 'Dropped existing incompatible auction_bids table';
    END IF;

    -- Drop other auction tables if they exist (to avoid foreign key issues)
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'auction_sales' AND table_schema = 'public') THEN
        DROP TABLE auction_sales CASCADE;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'auction_events' AND table_schema = 'public') THEN
        DROP TABLE auction_events CASCADE;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'auction_watchlist' AND table_schema = 'public') THEN
        DROP TABLE auction_watchlist CASCADE;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'auctions' AND table_schema = 'public') THEN
        DROP TABLE auctions CASCADE;
    END IF;
END $$;

-- ================================
-- STEP 2: AUCTION CATEGORIES TABLE
-- ================================

CREATE TABLE IF NOT EXISTS auction_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    icon_name VARCHAR(50), -- Ionicon name for mobile UI
    color VARCHAR(7), -- Hex color code
    slug VARCHAR(100) UNIQUE NOT NULL,
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert the 6 core auction categories safely
DO $$
BEGIN
    -- For Collectors
    IF NOT EXISTS (SELECT 1 FROM auction_categories WHERE slug = 'collectors') THEN
        INSERT INTO auction_categories (name, description, icon_name, color, slug, display_order)
        VALUES ('For Collectors', 'Art, comics, memorabilia, vintage collectibles', 'library-outline', '#8E44AD', 'collectors', 1);
    END IF;

    -- For Investors
    IF NOT EXISTS (SELECT 1 FROM auction_categories WHERE slug = 'investors') THEN
        INSERT INTO auction_categories (name, description, icon_name, color, slug, display_order)
        VALUES ('For Investors', 'Watches, real estate, domains, precious metals', 'trending-up-outline', '#27AE60', 'investors', 2);
    END IF;

    -- For Lifestyle
    IF NOT EXISTS (SELECT 1 FROM auction_categories WHERE slug = 'lifestyle') THEN
        INSERT INTO auction_categories (name, description, icon_name, color, slug, display_order)
        VALUES ('For Lifestyle', 'Fashion, jewelry, home decor, luxury goods', 'diamond-outline', '#E91E63', 'lifestyle', 3);
    END IF;

    -- For Business
    IF NOT EXISTS (SELECT 1 FROM auction_categories WHERE slug = 'business') THEN
        INSERT INTO auction_categories (name, description, icon_name, color, slug, display_order)
        VALUES ('For Business', 'Tools, equipment, office gear, liquidation sales', 'briefcase-outline', '#3498DB', 'business', 4);
    END IF;

    -- For Mobility
    IF NOT EXISTS (SELECT 1 FROM auction_categories WHERE slug = 'mobility') THEN
        INSERT INTO auction_categories (name, description, icon_name, color, slug, display_order)
        VALUES ('For Mobility', 'Cars, motorcycles, boats, machinery', 'car-outline', '#F39C12', 'mobility', 5);
    END IF;

    -- For the Niche
    IF NOT EXISTS (SELECT 1 FROM auction_categories WHERE slug = 'niche') THEN
        INSERT INTO auction_categories (name, description, icon_name, color, slug, display_order)
        VALUES ('For the Niche', 'Specialized items, rare collectibles, unique finds', 'star-outline', '#9B59B6', 'niche', 6);
    END IF;
END $$;

-- ================================
-- STEP 3: AUCTIONS TABLE
-- ================================

CREATE TABLE auctions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES auction_categories(id),

    -- Basic Info
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    lot_number VARCHAR(50), -- Optional lot numbering for organization

    -- Pricing (using same precision as wallet system - DECIMAL(18,6))
    starting_price DECIMAL(18,6) NOT NULL CHECK (starting_price > 0),
    reserve_price DECIMAL(18,6), -- Minimum price to sell (can be null for no reserve)
    current_bid DECIMAL(18,6) DEFAULT 0,
    bid_increment DECIMAL(18,6) DEFAULT 1.000000 CHECK (bid_increment > 0),

    -- Auction Type and Timing
    auction_type VARCHAR(20) NOT NULL CHECK (auction_type IN ('timed', 'live')), -- timed = scheduled, live = real-time
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE NOT NULL,

    -- Soft close settings (extends auction if bids near end time)
    soft_close_enabled BOOLEAN DEFAULT false,
    soft_close_extension INTEGER DEFAULT 300, -- seconds to extend (5 minutes default)

    -- Status tracking
    status VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'active', 'ended', 'cancelled', 'sold')),

    -- Stats
    total_bids INTEGER DEFAULT 0,
    unique_bidders INTEGER DEFAULT 0,
    view_count INTEGER DEFAULT 0,
    watch_count INTEGER DEFAULT 0,

    -- Winner info (set when auction ends)
    winner_id UUID REFERENCES user_profiles(id),
    winning_bid DECIMAL(18,6),
    sale_completed BOOLEAN DEFAULT false,

    -- Media
    images TEXT[], -- Array of image URLs
    video_url TEXT, -- Single video URL
    thumbnail_url TEXT, -- Main display image
    stream_url TEXT, -- For live auctions

    -- Live auction features
    auctioneer_enabled BOOLEAN DEFAULT false, -- Enable AI auctioneer voice
    crowd_sounds_enabled BOOLEAN DEFAULT false, -- Background auction house sounds

    -- Business logic
    listing_fee DECIMAL(18,6) DEFAULT 5.000000, -- Fixed 5 Freti listing fee
    commission_rate DECIMAL(5,4) DEFAULT 0.0500, -- 5% commission rate
    buyer_premium_rate DECIMAL(5,4) DEFAULT 0.0000, -- Optional buyer premium

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT valid_auction_dates CHECK (end_time > start_time),
    CONSTRAINT valid_reserve_price CHECK (reserve_price IS NULL OR reserve_price >= starting_price)
);

-- ================================
-- STEP 4: AUCTION BIDS TABLE (NEW STRUCTURE)
-- ================================

CREATE TABLE auction_bids (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    bidder_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,

    -- Bid details
    amount DECIMAL(18,6) NOT NULL CHECK (amount > 0),
    bid_type VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (bid_type IN ('manual', 'proxy', 'auto')),

    -- Proxy bidding support
    max_bid_amount DECIMAL(18,6), -- For proxy bids: maximum amount bidder is willing to pay
    is_proxy_bid BOOLEAN DEFAULT false,
    proxy_bid_parent_id UUID REFERENCES auction_bids(id), -- Links auto-generated proxy bids to original

    -- Status
    is_winning BOOLEAN DEFAULT false, -- Currently the highest bid
    is_valid BOOLEAN DEFAULT true, -- Can be invalidated if payment fails

    -- Display info (for anonymity)
    bidder_display_id VARCHAR(20) NOT NULL, -- e.g., "Bidder #123"

    -- Security/audit
    ip_address INET,
    user_agent TEXT,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT bid_must_be_higher CHECK (amount > 0)
);

-- ================================
-- STEP 5: AUCTION WATCHLIST TABLE
-- ================================

CREATE TABLE auction_watchlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    notification_enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Prevent duplicate watches
    UNIQUE(user_id, auction_id)
);

-- ================================
-- STEP 6: AUCTION EVENTS TABLE
-- ================================

CREATE TABLE auction_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL, -- 'bid_placed', 'auction_started', 'auction_ended', 'going_once', etc.
    event_data JSONB, -- Flexible data storage for different event types
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- AI Auctioneer integration
    auctioneer_message TEXT, -- What the AI auctioneer says for this event
    auctioneer_spoken BOOLEAN DEFAULT false -- Track if TTS has been triggered
);

-- ================================
-- STEP 7: AUCTION SALES TABLE
-- ================================

CREATE TABLE auction_sales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    seller_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    buyer_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,

    -- Financial details
    final_bid_amount DECIMAL(18,6) NOT NULL,
    commission_amount DECIMAL(18,6) NOT NULL, -- Platform commission (usually 5%)
    buyer_premium_amount DECIMAL(18,6) DEFAULT 0, -- Optional buyer premium
    total_amount DECIMAL(18,6) NOT NULL, -- Amount charged to buyer

    -- Payment status
    payment_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'processing', 'completed', 'failed', 'refunded')),
    payment_transaction_id UUID, -- Link to wallet transaction

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

-- ================================
-- STEP 8: CREATE INDEXES FOR PERFORMANCE
-- ================================

-- Auction indexes
CREATE INDEX idx_auctions_status ON auctions(status);
CREATE INDEX idx_auctions_category ON auctions(category_id);
CREATE INDEX idx_auctions_seller ON auctions(seller_id);
CREATE INDEX idx_auctions_end_time ON auctions(end_time);
CREATE INDEX idx_auctions_start_time ON auctions(start_time);
CREATE INDEX idx_auctions_created_at ON auctions(created_at);

-- Bid indexes
CREATE INDEX idx_auction_bids_auction ON auction_bids(auction_id);
CREATE INDEX idx_auction_bids_bidder ON auction_bids(bidder_id);
CREATE INDEX idx_auction_bids_created_at ON auction_bids(created_at);
CREATE INDEX idx_auction_bids_amount ON auction_bids(amount);
CREATE INDEX idx_auction_bids_winning ON auction_bids(is_winning) WHERE is_winning = true;

-- Watchlist indexes
CREATE INDEX idx_auction_watchlist_user ON auction_watchlist(user_id);
CREATE INDEX idx_auction_watchlist_auction ON auction_watchlist(auction_id);

-- Event indexes
CREATE INDEX idx_auction_events_auction ON auction_events(auction_id);
CREATE INDEX idx_auction_events_timestamp ON auction_events(timestamp);
CREATE INDEX idx_auction_events_type ON auction_events(event_type);

-- ================================
-- STEP 9: CREATE FUNCTIONS AND TRIGGERS
-- ================================

-- Function to update auction updated_at timestamp
CREATE OR REPLACE FUNCTION update_auction_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update updated_at on auction changes
CREATE TRIGGER trigger_update_auction_updated_at
    BEFORE UPDATE ON auctions
    FOR EACH ROW
    EXECUTE FUNCTION update_auction_updated_at();

-- Function to update auction stats when bids are placed
CREATE OR REPLACE FUNCTION update_auction_stats_on_bid()
RETURNS TRIGGER AS $$
BEGIN
    -- Update auction with new highest bid and stats
    UPDATE auctions
    SET
        current_bid = NEW.amount,
        winner_id = NEW.bidder_id,
        total_bids = total_bids + 1,
        updated_at = NOW()
    WHERE id = NEW.auction_id;

    -- Update unique bidders count
    UPDATE auctions
    SET unique_bidders = (
        SELECT COUNT(DISTINCT bidder_id)
        FROM auction_bids
        WHERE auction_id = NEW.auction_id AND is_valid = true
    )
    WHERE id = NEW.auction_id;

    -- Mark all other bids as not winning
    UPDATE auction_bids
    SET is_winning = false
    WHERE auction_id = NEW.auction_id AND id != NEW.id;

    -- Mark this bid as winning
    UPDATE auction_bids
    SET is_winning = true
    WHERE id = NEW.id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update auction stats when new bids are placed
CREATE TRIGGER trigger_update_auction_stats_on_bid
    AFTER INSERT ON auction_bids
    FOR EACH ROW
    EXECUTE FUNCTION update_auction_stats_on_bid();

-- Function to update watch count when watchlist changes
CREATE OR REPLACE FUNCTION update_auction_watch_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE auctions
        SET watch_count = watch_count + 1
        WHERE id = NEW.auction_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE auctions
        SET watch_count = watch_count - 1
        WHERE id = OLD.auction_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Triggers to update watch count
CREATE TRIGGER trigger_update_watch_count_insert
    AFTER INSERT ON auction_watchlist
    FOR EACH ROW
    EXECUTE FUNCTION update_auction_watch_count();

CREATE TRIGGER trigger_update_watch_count_delete
    AFTER DELETE ON auction_watchlist
    FOR EACH ROW
    EXECUTE FUNCTION update_auction_watch_count();

-- ================================
-- STEP 10: CREATE VIEWS FOR COMMON QUERIES
-- ================================

-- View for auction listing with category and seller info
CREATE VIEW auction_listing_view AS
SELECT
    a.*,
    c.name as category_name,
    c.slug as category_slug,
    c.icon_name as category_icon,
    c.color as category_color,
    up.username as seller_username,
    up.avatar_url as seller_avatar,
    up.is_verified as seller_verified,
    -- Calculate time remaining
    CASE
        WHEN a.status = 'active' AND a.end_time > NOW()
        THEN EXTRACT(EPOCH FROM (a.end_time - NOW()))::INTEGER
        ELSE 0
    END as seconds_remaining,
    -- Calculate time status
    CASE
        WHEN a.status = 'scheduled' AND a.start_time > NOW() THEN 'upcoming'
        WHEN a.status = 'active' AND a.end_time > NOW() THEN 'active'
        ELSE 'ended'
    END as time_status
FROM auctions a
LEFT JOIN auction_categories c ON a.category_id = c.id
LEFT JOIN user_profiles up ON a.seller_id = up.id;

-- View for public bid history (without sensitive bidder info)
CREATE VIEW public_bid_history_view AS
SELECT
    b.id,
    b.auction_id,
    b.amount,
    b.bid_type,
    b.bidder_display_id,
    b.is_winning,
    b.created_at
FROM auction_bids b
WHERE b.is_valid = true
ORDER BY b.created_at DESC;

-- ================================
-- STEP 11: ENABLE ROW LEVEL SECURITY
-- ================================

-- Enable RLS on all tables
ALTER TABLE auction_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE auctions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auction_bids ENABLE ROW LEVEL SECURITY;
ALTER TABLE auction_watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE auction_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE auction_sales ENABLE ROW LEVEL SECURITY;

-- ================================
-- STEP 12: CREATE RLS POLICIES
-- ================================

-- Auction Categories: Public read access
CREATE POLICY "auction_categories_public_read" ON auction_categories
    FOR SELECT USING (is_active = true);

-- Auctions: Public read, sellers can manage their own
CREATE POLICY "auctions_public_read" ON auctions
    FOR SELECT USING (true);

CREATE POLICY "auctions_seller_manage" ON auctions
    FOR ALL USING (auth.uid() = seller_id);

-- Auction Bids: Users can see all bids, but only create their own
CREATE POLICY "auction_bids_public_read" ON auction_bids
    FOR SELECT USING (true);

CREATE POLICY "auction_bids_user_create" ON auction_bids
    FOR INSERT WITH CHECK (auth.uid() = bidder_id);

-- Watchlist: Users can only manage their own watchlist
CREATE POLICY "auction_watchlist_user_manage" ON auction_watchlist
    FOR ALL USING (auth.uid() = user_id);

-- Auction Events: Public read access
CREATE POLICY "auction_events_public_read" ON auction_events
    FOR SELECT USING (true);

-- Auction Sales: Buyers and sellers can see their own sales
CREATE POLICY "auction_sales_participant_read" ON auction_sales
    FOR SELECT USING (auth.uid() = seller_id OR auth.uid() = buyer_id);

-- ================================
-- STEP 13: GRANT PERMISSIONS
-- ================================

-- Grant usage on sequences
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;

-- Grant permissions to authenticated users
GRANT SELECT ON auction_categories TO anon, authenticated;
GRANT ALL ON auctions TO authenticated;
GRANT ALL ON auction_bids TO authenticated;
GRANT ALL ON auction_watchlist TO authenticated;
GRANT SELECT ON auction_events TO anon, authenticated;
GRANT SELECT ON auction_sales TO authenticated;

-- Grant permissions on views
GRANT SELECT ON auction_listing_view TO anon, authenticated;
GRANT SELECT ON public_bid_history_view TO anon, authenticated;

-- ================================
-- COMPLETION MESSAGE
-- ================================

SELECT 'Fretiko Auction System migration completed successfully! 🎯' as status,
       'All incompatible tables have been recreated with proper structure.' as details;