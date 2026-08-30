-- Migration: Create Live Sales Event Configuration
-- Date: 2026-08-25
-- Description: Admin-controlled settings for live sales watch rewards, leaderboards, and special events

BEGIN;

-- ================================
-- LIVE SALES EVENT CONFIG
-- ================================

CREATE TABLE IF NOT EXISTS live_sales_event_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Watch rewards settings
    watch_rewards_enabled BOOLEAN DEFAULT FALSE,
    watch_time_minutes INTEGER NOT NULL DEFAULT 10 CHECK (watch_time_minutes > 0),
    freti_per_reward DECIMAL(18,6) NOT NULL DEFAULT 1.000000 CHECK (freti_per_reward >= 0),
    daily_cap_per_user DECIMAL(18,6) DEFAULT 0 CHECK (daily_cap_per_user >= 0), -- 0 means no cap
    per_stream_cap_per_user DECIMAL(18,6) DEFAULT 0 CHECK (per_stream_cap_per_user >= 0), -- 0 means no cap
    notifications_enabled BOOLEAN DEFAULT TRUE,

    -- Vendor leaderboard settings
    leaderboard_enabled BOOLEAN DEFAULT FALSE,
    default_order_weight INTEGER NOT NULL DEFAULT 40 CHECK (default_order_weight >= 0),
    default_viewer_weight INTEGER NOT NULL DEFAULT 30 CHECK (default_viewer_weight >= 0),
    default_revenue_weight INTEGER NOT NULL DEFAULT 30 CHECK (default_revenue_weight >= 0),
    CONSTRAINT default_weights_sum CHECK (default_order_weight + default_viewer_weight + default_revenue_weight = 100),

    -- Special event settings
    special_event_enabled BOOLEAN DEFAULT FALSE,
    special_event_name VARCHAR(255),
    special_event_start_at TIMESTAMP WITH TIME ZONE,
    special_event_end_at TIMESTAMP WITH TIME ZONE,
    special_event_order_weight INTEGER NOT NULL DEFAULT 40 CHECK (special_event_order_weight >= 0),
    special_event_viewer_weight INTEGER NOT NULL DEFAULT 30 CHECK (special_event_viewer_weight >= 0),
    special_event_revenue_weight INTEGER NOT NULL DEFAULT 30 CHECK (special_event_revenue_weight >= 0),
    CONSTRAINT special_event_weights_sum CHECK (special_event_order_weight + special_event_viewer_weight + special_event_revenue_weight = 100),

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Ensure at most one configuration row. Since id is PK, we rely on admin logic to manage a single row (id = first row).
-- Alternatively, a singleton constraint could be added if a fixed key is desired.

-- Index
CREATE INDEX IF NOT EXISTS idx_live_sales_event_config_updated_at ON live_sales_event_config(updated_at DESC);

-- Row Level Security
ALTER TABLE live_sales_event_config ENABLE ROW LEVEL SECURITY;

-- Anyone can view active config (needed by mobile apps)
CREATE POLICY "Anyone can view live sales event config"
ON live_sales_event_config FOR SELECT
TO authenticated
USING (true);

-- Only service role can manage config (admin uses service role)
CREATE POLICY "Service role can manage live sales event config"
ON live_sales_event_config FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Grant permissions
GRANT SELECT ON live_sales_event_config TO authenticated;
GRANT ALL ON live_sales_event_config TO service_role;

-- Insert default config row
INSERT INTO live_sales_event_config (
    watch_rewards_enabled,
    watch_time_minutes,
    freti_per_reward,
    leaderboard_enabled,
    default_order_weight,
    default_viewer_weight,
    default_revenue_weight
)
SELECT false, 10, 1.000000, false, 40, 30, 30
WHERE NOT EXISTS (SELECT 1 FROM live_sales_event_config);

COMMIT;
