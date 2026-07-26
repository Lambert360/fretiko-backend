-- Migration 168: Create user_feed_impressions table
-- Purpose: Track which unified feed items (posts/services) a user has already
-- seen, so the feed ranking algorithm can soft-downrank repeatedly-seen items
-- and prioritize fresh/unseen content (similar to Facebook's "unread bump").

CREATE TABLE IF NOT EXISTS user_feed_impressions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL CHECK (item_type IN ('post', 'service')),
    item_id UUID NOT NULL,
    seen_count INTEGER NOT NULL DEFAULT 1,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_feed_impressions_user ON user_feed_impressions(user_id);
CREATE INDEX IF NOT EXISTS idx_feed_impressions_user_item ON user_feed_impressions(user_id, item_type, item_id);

-- Enable RLS: users can only read/write their own impression rows
ALTER TABLE user_feed_impressions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own feed impressions"
    ON user_feed_impressions FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can upsert own feed impressions"
    ON user_feed_impressions FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own feed impressions"
    ON user_feed_impressions FOR UPDATE
    USING (auth.uid() = user_id);

-- Note: backend uses the service-role client for feed ranking, which bypasses
-- RLS, so these policies primarily guard against direct client access.
