-- Migration: Create tags, taggings, and mentions system
-- Date: 2026-06-04
-- Description: Add support tables for #tags and @mentions across posts, products, services, comments, and other content types

-- ================================
-- 1. TAGS TABLE
-- ================================
CREATE TABLE IF NOT EXISTS tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Normalized tag name used for lookups (e.g. 'fashion')
    name VARCHAR(100) NOT NULL UNIQUE,

    -- Display name as originally typed (e.g. 'Fashion', 'FASHION')
    display_name VARCHAR(100) NOT NULL,

    -- Simple usage counter for trending calculations
    usage_count INTEGER NOT NULL DEFAULT 0,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
CREATE INDEX IF NOT EXISTS idx_tags_usage_count ON tags(usage_count DESC);

-- ================================
-- 2. TAGGINGS TABLE (POLYMORPHIC)
-- ================================
CREATE TABLE IF NOT EXISTS taggings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,

    -- ID of the tagged content (post, product, service, comment, etc.)
    taggable_id UUID NOT NULL,

    -- Type discriminator: 'post', 'product', 'service', 'comment', 'chat_message', etc.
    taggable_type VARCHAR(50) NOT NULL,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(tag_id, taggable_id, taggable_type)
);

CREATE INDEX IF NOT EXISTS idx_taggings_tag_id ON taggings(tag_id);
CREATE INDEX IF NOT EXISTS idx_taggings_taggable ON taggings(taggable_id, taggable_type);

-- Restrict direct access to taggings to backend/service role only
GRANT ALL ON tags TO service_role;
GRANT ALL ON taggings TO service_role;

GRANT SELECT ON tags TO authenticated;
GRANT SELECT ON tags TO anon;

-- ================================
-- 3. MENTIONS TABLE
-- ================================
CREATE TABLE IF NOT EXISTS mentions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- User who was mentioned (@username target)
    mentioned_user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,

    -- User who created the content containing the mention
    mentioner_user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,

    -- ID of the content where the mention occurred (post, product, service, comment, etc.)
    mentionable_id UUID NOT NULL,

    -- Type discriminator: 'post', 'product', 'service', 'comment', etc.
    mentionable_type VARCHAR(50) NOT NULL,

    is_read BOOLEAN NOT NULL DEFAULT FALSE,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mentions_mentioned_user_id ON mentions(mentioned_user_id);
CREATE INDEX IF NOT EXISTS idx_mentions_mentionable ON mentions(mentionable_id, mentionable_type);
CREATE INDEX IF NOT EXISTS idx_mentions_unread ON mentions(mentioned_user_id, is_read) WHERE is_read = FALSE;

-- Enable RLS for mentions to ensure privacy
ALTER TABLE mentions ENABLE ROW LEVEL SECURITY;

-- Only the mentioned user can read their mentions (plus service role via bypass)
CREATE POLICY "Users can view their own mentions" ON mentions
    FOR SELECT USING (auth.uid() = mentioned_user_id);

-- Mentions are inserted by backend services using service_role key; allow all inserts
CREATE POLICY "Backend can insert mentions" ON mentions
    FOR INSERT WITH CHECK (true);

GRANT ALL ON mentions TO service_role;

COMMIT;
