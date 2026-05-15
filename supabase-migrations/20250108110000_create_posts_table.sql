-- Migration: Create Posts System Tables
-- Created: 2025-01-08
-- Purpose: Social media post system for Fretiko app

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Posts Table: Core post content
CREATE TABLE posts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    content TEXT,
    media_urls TEXT[] DEFAULT '{}',
    media_type VARCHAR(20) NOT NULL DEFAULT 'text' CHECK (media_type IN ('text', 'image', 'video', 'mixed')),
    privacy_level VARCHAR(20) NOT NULL DEFAULT 'public' CHECK (privacy_level IN ('public', 'friends', 'private')),
    likes_count INTEGER NOT NULL DEFAULT 0,
    comments_count INTEGER NOT NULL DEFAULT 0,
    shares_count INTEGER NOT NULL DEFAULT 0,
    gifts_count INTEGER NOT NULL DEFAULT 0,
    is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Post Interactions Table: Unified table for all interactions (likes, comments, shares, gifts)
CREATE TABLE post_interactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    interaction_type VARCHAR(20) NOT NULL CHECK (interaction_type IN ('like', 'comment', 'share', 'gift')),
    content TEXT, -- For comments
    gift_id UUID REFERENCES virtual_gifts(id) ON DELETE SET NULL, -- For gift interactions
    parent_comment_id UUID REFERENCES post_interactions(id), -- For threaded comments
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(post_id, user_id, interaction_type) -- Prevent duplicate likes/shares per user
);

-- Post Media Table: Detailed media metadata
CREATE TABLE post_media (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    media_type VARCHAR(10) NOT NULL CHECK (media_type IN ('image', 'video')),
    media_url TEXT NOT NULL,
    thumbnail_url TEXT,
    file_size BIGINT,
    duration INTEGER, -- For videos in seconds
    width INTEGER,
    height INTEGER,
    mime_type VARCHAR(50),
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Post Bookmarks Table: User bookmarks
CREATE TABLE post_bookmarks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(post_id, user_id)
);

-- Post Reports Table: Content moderation
CREATE TABLE post_reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    reporter_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    reason VARCHAR(100) NOT NULL,
    details TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'resolved', 'dismissed')),
    reviewed_by UUID REFERENCES user_profiles(id),
    reviewed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- User Feed Table: Pre-computed feed for users (mixes posts and services)
CREATE TABLE user_feed (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    item_id UUID NOT NULL, -- Can be post_id or service_id
    item_type VARCHAR(20) NOT NULL CHECK (item_type IN ('post', 'service')),
    score DECIMAL(10,6) NOT NULL DEFAULT 0.0,
    is_seen BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_posts_user_id ON posts(user_id);
CREATE INDEX idx_posts_created_at ON posts(created_at DESC);
CREATE INDEX idx_posts_privacy_level ON posts(privacy_level);
CREATE INDEX idx_posts_is_deleted ON posts(is_deleted);
CREATE INDEX idx_posts_is_pinned ON posts(is_pinned) WHERE is_pinned = TRUE;

CREATE INDEX idx_post_interactions_post_id ON post_interactions(post_id);
CREATE INDEX idx_post_interactions_user_id ON post_interactions(user_id);
CREATE INDEX idx_post_interactions_type ON post_interactions(interaction_type);

CREATE INDEX idx_post_media_post_id ON post_media(post_id);
CREATE INDEX idx_post_media_order ON post_media(post_id, order_index);

CREATE INDEX idx_post_bookmarks_user_id ON post_bookmarks(user_id);
CREATE INDEX idx_post_bookmarks_post_id ON post_bookmarks(post_id);

CREATE INDEX idx_user_feed_user_id ON user_feed(user_id);
CREATE INDEX idx_user_feed_score ON user_feed(user_id, score DESC);
CREATE INDEX idx_user_feed_item ON user_feed(item_id, item_type);

-- Row Level Security (RLS) Policies
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_feed ENABLE ROW LEVEL SECURITY;

-- Posts RLS: Users can see public posts, their own posts, and friends' posts
CREATE POLICY "Posts are viewable by everyone for public posts" ON posts
    FOR SELECT USING (
        privacy_level = 'public' 
        AND is_deleted = FALSE
        OR user_id = auth.uid()
        OR (privacy_level = 'friends' AND EXISTS (
            SELECT 1 FROM user_connections 
            WHERE status = 'accepted'
            AND ((requester_id = auth.uid() AND addressee_id = posts.user_id)
            OR (addressee_id = auth.uid() AND requester_id = posts.user_id))
        ))
    );

CREATE POLICY "Users can insert their own posts" ON posts
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own posts" ON posts
    FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY "Users can delete their own posts" ON posts
    FOR DELETE USING (user_id = auth.uid());

-- Post Interactions RLS
CREATE POLICY "Interactions are viewable by everyone" ON post_interactions
    FOR SELECT USING (TRUE);

CREATE POLICY "Users can create their own interactions" ON post_interactions
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete their own interactions" ON post_interactions
    FOR DELETE USING (user_id = auth.uid());

-- Post Media RLS
CREATE POLICY "Post media is viewable by everyone" ON post_media
    FOR SELECT USING (TRUE);

-- Bookmarks RLS
CREATE POLICY "Users can view their own bookmarks" ON post_bookmarks
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can create their own bookmarks" ON post_bookmarks
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete their own bookmarks" ON post_bookmarks
    FOR DELETE USING (user_id = auth.uid());

-- Functions for updating counts
CREATE OR REPLACE FUNCTION update_post_counts()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.interaction_type = 'like' THEN
            UPDATE posts SET likes_count = likes_count + 1 WHERE id = NEW.post_id;
        ELSIF NEW.interaction_type = 'comment' THEN
            UPDATE posts SET comments_count = comments_count + 1 WHERE id = NEW.post_id;
        ELSIF NEW.interaction_type = 'share' THEN
            UPDATE posts SET shares_count = shares_count + 1 WHERE id = NEW.post_id;
        ELSIF NEW.interaction_type = 'gift' THEN
            UPDATE posts SET gifts_count = gifts_count + 1 WHERE id = NEW.post_id;
        END IF;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        IF OLD.interaction_type = 'like' THEN
            UPDATE posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = OLD.post_id;
        ELSIF OLD.interaction_type = 'comment' THEN
            UPDATE posts SET comments_count = GREATEST(0, comments_count - 1) WHERE id = OLD.post_id;
        ELSIF OLD.interaction_type = 'share' THEN
            UPDATE posts SET shares_count = GREATEST(0, shares_count - 1) WHERE id = OLD.post_id;
        ELSIF OLD.interaction_type = 'gift' THEN
            UPDATE posts SET gifts_count = GREATEST(0, gifts_count - 1) WHERE id = OLD.post_id;
        END IF;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Triggers for count updates
CREATE TRIGGER post_interactions_count_trigger
    AFTER INSERT OR DELETE ON post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION update_post_counts();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER posts_updated_at_trigger
    BEFORE UPDATE ON posts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Comments
COMMENT ON TABLE posts IS 'Social media posts created by users';
COMMENT ON TABLE post_interactions IS 'User interactions on posts (likes, comments, shares, gifts)';
COMMENT ON TABLE post_media IS 'Media files attached to posts with metadata';
COMMENT ON TABLE post_bookmarks IS 'User bookmarks for posts';
COMMENT ON TABLE post_reports IS 'Content moderation reports for posts';
COMMENT ON TABLE user_feed IS 'Pre-computed personalized feed for users';
