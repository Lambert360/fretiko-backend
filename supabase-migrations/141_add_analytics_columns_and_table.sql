-- Migration: Add Analytics Columns and Create Analytics Events Table
-- Date: 2026-01-19
-- Description: Add missing analytics columns to live_streams and create analytics_events table

-- ================================
-- ADD MISSING COLUMNS TO live_streams
-- ================================

ALTER TABLE live_streams
ADD COLUMN IF NOT EXISTS peak_viewers INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_comments INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_reactions INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_gifts INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_gift_value DECIMAL(10,2) DEFAULT 0,
ADD COLUMN IF NOT EXISTS engagement_score DECIMAL(10,2) DEFAULT 0;

-- Add comments for documentation
COMMENT ON COLUMN live_streams.peak_viewers IS 'Peak concurrent viewer count during the stream';
COMMENT ON COLUMN live_streams.total_comments IS 'Total number of comments received during the stream';
COMMENT ON COLUMN live_streams.total_reactions IS 'Total number of reactions (hearts, fire, etc.) received';
COMMENT ON COLUMN live_streams.total_gifts IS 'Total number of gifts sent by viewers';
COMMENT ON COLUMN live_streams.total_gift_value IS 'Total monetary value of all gifts received';
COMMENT ON COLUMN live_streams.engagement_score IS 'Calculated engagement score based on interactions';

-- ================================
-- CREATE analytics_events TABLE
-- ================================

CREATE TABLE IF NOT EXISTS analytics_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id UUID REFERENCES live_streams(id) ON DELETE CASCADE,
    user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
    event_type VARCHAR(50) NOT NULL CHECK (event_type IN (
        'stream_start',
        'stream_end',
        'viewer_join',
        'viewer_leave',
        'comment',
        'reaction',
        'gift_sent',
        'product_purchased',
        'service_booked'
    )),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================
-- INDEXES
-- ================================

CREATE INDEX IF NOT EXISTS idx_analytics_events_stream_id ON analytics_events(stream_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_id ON analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_stream_created ON analytics_events(stream_id, created_at DESC);

-- ================================
-- ROW LEVEL SECURITY (RLS)
-- ================================

ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;

-- Users can view their own analytics events
CREATE POLICY "Users can view own analytics events"
    ON analytics_events FOR SELECT
    USING (auth.uid() = user_id);

-- Stream owners can view all events for their streams
CREATE POLICY "Stream owners can view stream analytics"
    ON analytics_events FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM live_streams
            WHERE live_streams.id = analytics_events.stream_id
            AND live_streams.vendor_id = auth.uid()
        )
    );

-- System can insert analytics events (via service role)
-- Note: Backend uses service role client, so this policy is for direct Supabase access
CREATE POLICY "Authenticated users can insert analytics events"
    ON analytics_events FOR INSERT
    WITH CHECK (auth.uid() IS NOT NULL);

-- ================================
-- COMMENTS
-- ================================

COMMENT ON TABLE analytics_events IS 'Stores individual analytics events for live streams and general analytics';
COMMENT ON COLUMN analytics_events.stream_id IS 'Optional: Stream ID if event is stream-related';
COMMENT ON COLUMN analytics_events.user_id IS 'User who triggered the event (null for system events)';
COMMENT ON COLUMN analytics_events.event_type IS 'Type of analytics event';
COMMENT ON COLUMN analytics_events.metadata IS 'Additional event data in JSON format';

