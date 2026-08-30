-- Migration: Create Vendor Leaderboard Cache
-- Date: 2026-08-25
-- Description: Pre-computed vendor leaderboard for default and special event scoring

BEGIN;

-- ================================
-- VENDOR LEADERBOARD CACHE TABLE
-- ================================

CREATE TABLE IF NOT EXISTS vendor_leaderboard_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,

    period VARCHAR(20) NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly', 'event')),
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    event_name VARCHAR(255), -- Only set for period = 'event'

    rank INTEGER NOT NULL,
    score DECIMAL(18,6) NOT NULL DEFAULT 0,

    total_streams INTEGER NOT NULL DEFAULT 0,
    total_orders INTEGER NOT NULL DEFAULT 0,
    total_viewers INTEGER NOT NULL DEFAULT 0,
    total_revenue DECIMAL(18,6) NOT NULL DEFAULT 0,
    orders_per_stream DECIMAL(18,6) NOT NULL DEFAULT 0,
    avg_viewers_per_stream DECIMAL(18,6) NOT NULL DEFAULT 0,
    revenue_per_stream DECIMAL(18,6) NOT NULL DEFAULT 0,

    order_weight INTEGER NOT NULL DEFAULT 40,
    viewer_weight INTEGER NOT NULL DEFAULT 30,
    revenue_weight INTEGER NOT NULL DEFAULT 30,

    calculated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    UNIQUE(vendor_id, period, period_start, period_end, event_name)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_vendor_leaderboard_period ON vendor_leaderboard_cache(period);
CREATE INDEX IF NOT EXISTS idx_vendor_leaderboard_rank ON vendor_leaderboard_cache(period, rank);
CREATE INDEX IF NOT EXISTS idx_vendor_leaderboard_vendor ON vendor_leaderboard_cache(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vendor_leaderboard_calculated_at ON vendor_leaderboard_cache(calculated_at DESC);

-- Row Level Security
ALTER TABLE vendor_leaderboard_cache ENABLE ROW LEVEL SECURITY;

-- Anyone can view the leaderboard
CREATE POLICY "Anyone can view vendor leaderboard"
ON vendor_leaderboard_cache FOR SELECT
TO authenticated
USING (true);

-- Service role can manage cache
CREATE POLICY "Service role can manage vendor leaderboard cache"
ON vendor_leaderboard_cache FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Grant permissions
GRANT SELECT ON vendor_leaderboard_cache TO authenticated;
GRANT ALL ON vendor_leaderboard_cache TO service_role;

-- Trigger for updated_at (only if the helper function exists)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'update_updated_at_column') THEN
        EXECUTE 'CREATE TRIGGER update_vendor_leaderboard_cache_updated_at BEFORE UPDATE ON vendor_leaderboard_cache FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()';
    END IF;
END $$;

COMMIT;
