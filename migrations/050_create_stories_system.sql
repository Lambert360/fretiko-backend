-- Migration: Create Stories System
-- Date: 2025-09-25
-- Description: Create stories system for vendors/riders to share temporary content with plugged users

-- ================================
-- STORIES TABLE
-- ================================

CREATE TABLE stories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    media_url TEXT NOT NULL,
    media_type VARCHAR(10) NOT NULL CHECK (media_type IN ('image', 'video')) DEFAULT 'image',
    thumbnail_url TEXT,
    caption TEXT,
    duration INTEGER, -- For videos, duration in seconds

    -- Story visibility and expiry
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    is_active BOOLEAN DEFAULT true,

    -- Analytics
    view_count INTEGER DEFAULT 0,
    like_count INTEGER DEFAULT 0,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================
-- STORY VIEWS TABLE
-- ================================

CREATE TABLE story_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    viewer_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    viewed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Prevent duplicate views
    UNIQUE(story_id, viewer_id)
);

-- ================================
-- STORY LIKES TABLE
-- ================================

CREATE TABLE story_likes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Prevent duplicate likes
    UNIQUE(story_id, user_id)
);

-- ================================
-- STORY COMMENTS TABLE
-- ================================

CREATE TABLE story_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    story_id UUID NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================
-- INDEXES FOR PERFORMANCE
-- ================================

-- Stories indexes
CREATE INDEX idx_stories_user_id ON stories(user_id);
CREATE INDEX idx_stories_created_at ON stories(created_at DESC);
CREATE INDEX idx_stories_expires_at ON stories(expires_at);
CREATE INDEX idx_stories_active ON stories(is_active) WHERE is_active = true;

-- Story views indexes
CREATE INDEX idx_story_views_story_id ON story_views(story_id);
CREATE INDEX idx_story_views_viewer_id ON story_views(viewer_id);
CREATE INDEX idx_story_views_viewed_at ON story_views(viewed_at DESC);

-- Story likes indexes
CREATE INDEX idx_story_likes_story_id ON story_likes(story_id);
CREATE INDEX idx_story_likes_user_id ON story_likes(user_id);

-- Story comments indexes
CREATE INDEX idx_story_comments_story_id ON story_comments(story_id);
CREATE INDEX idx_story_comments_user_id ON story_comments(user_id);
CREATE INDEX idx_story_comments_created_at ON story_comments(created_at DESC);

-- ================================
-- STORAGE BUCKET FOR STORIES
-- ================================

-- Create stories storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('stories', 'stories', true)
ON CONFLICT (id) DO NOTHING;

-- ================================
-- STORAGE POLICIES FOR STORIES
-- ================================

-- Stories are publicly viewable (but access controlled by app logic)
CREATE POLICY "Story media is publicly accessible" ON storage.objects
    FOR SELECT USING (bucket_id = 'stories');

-- Users can upload their own stories
CREATE POLICY "Users can upload their own stories" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'stories'
        AND auth.uid()::text = (storage.foldername(name))[1]
    );

-- Users can update their own stories
CREATE POLICY "Users can update their own stories" ON storage.objects
    FOR UPDATE USING (
        bucket_id = 'stories'
        AND auth.uid()::text = (storage.foldername(name))[1]
    );

-- Users can delete their own stories
CREATE POLICY "Users can delete their own stories" ON storage.objects
    FOR DELETE USING (
        bucket_id = 'stories'
        AND auth.uid()::text = (storage.foldername(name))[1]
    );

-- ================================
-- ROW LEVEL SECURITY POLICIES
-- ================================

-- Enable RLS on all tables
ALTER TABLE stories ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_comments ENABLE ROW LEVEL SECURITY;

-- Stories policies
-- Users can view stories from people they're connected to OR their own stories
CREATE POLICY "Users can view stories from plugged users" ON stories
    FOR SELECT USING (
        auth.uid() = user_id OR -- Own stories
        EXISTS (
            SELECT 1 FROM user_connections
            WHERE status = 'accepted'
            AND (
                (requester_id = auth.uid() AND addressee_id = stories.user_id) OR
                (addressee_id = auth.uid() AND requester_id = stories.user_id)
            )
        )
    );

-- Users can only create their own stories
CREATE POLICY "Users can create own stories" ON stories
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can only update their own stories
CREATE POLICY "Users can update own stories" ON stories
    FOR UPDATE USING (auth.uid() = user_id);

-- Users can only delete their own stories
CREATE POLICY "Users can delete own stories" ON stories
    FOR DELETE USING (auth.uid() = user_id);

-- Story views policies
CREATE POLICY "Users can view story views" ON story_views
    FOR SELECT USING (
        auth.uid() = viewer_id OR -- Own views
        EXISTS (
            SELECT 1 FROM stories
            WHERE stories.id = story_views.story_id
            AND stories.user_id = auth.uid()
        ) -- Views on own stories
    );

CREATE POLICY "Users can create story views" ON story_views
    FOR INSERT WITH CHECK (auth.uid() = viewer_id);

-- Story likes policies
CREATE POLICY "Users can view story likes" ON story_likes
    FOR SELECT USING (
        auth.uid() = user_id OR -- Own likes
        EXISTS (
            SELECT 1 FROM stories
            WHERE stories.id = story_likes.story_id
            AND stories.user_id = auth.uid()
        ) -- Likes on own stories
    );

CREATE POLICY "Users can manage their story likes" ON story_likes
    FOR ALL USING (auth.uid() = user_id);

-- Story comments policies
CREATE POLICY "Users can view story comments" ON story_comments
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM stories
            WHERE stories.id = story_comments.story_id
            AND (
                stories.user_id = auth.uid() OR -- Own stories
                EXISTS (
                    SELECT 1 FROM user_connections
                    WHERE status = 'accepted'
                    AND (
                        (requester_id = auth.uid() AND addressee_id = stories.user_id) OR
                        (addressee_id = auth.uid() AND requester_id = stories.user_id)
                    )
                )
            )
        )
    );

CREATE POLICY "Users can create story comments" ON story_comments
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own story comments" ON story_comments
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own story comments" ON story_comments
    FOR DELETE USING (auth.uid() = user_id);

-- ================================
-- UPDATE TRIGGERS FOR TIMESTAMPS
-- ================================

-- Apply timestamp triggers (reusing existing function)
CREATE TRIGGER update_stories_updated_at
    BEFORE UPDATE ON stories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_story_comments_updated_at
    BEFORE UPDATE ON story_comments
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================
-- COUNT UPDATE TRIGGERS
-- ================================

-- Function to update story view count
CREATE OR REPLACE FUNCTION update_story_view_count() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE stories SET view_count = view_count + 1 WHERE id = NEW.story_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE stories SET view_count = view_count - 1 WHERE id = OLD.story_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to update story like count
CREATE OR REPLACE FUNCTION update_story_like_count() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE stories SET like_count = like_count + 1 WHERE id = NEW.story_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE stories SET like_count = like_count - 1 WHERE id = OLD.story_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Apply count triggers
CREATE TRIGGER story_views_count_trigger
    AFTER INSERT OR DELETE ON story_views
    FOR EACH ROW EXECUTE FUNCTION update_story_view_count();

CREATE TRIGGER story_likes_count_trigger
    AFTER INSERT OR DELETE ON story_likes
    FOR EACH ROW EXECUTE FUNCTION update_story_like_count();

-- ================================
-- CLEANUP FUNCTION FOR EXPIRED STORIES
-- ================================

-- Function to clean up expired stories
CREATE OR REPLACE FUNCTION cleanup_expired_stories() RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- Delete expired stories and get count
    DELETE FROM stories
    WHERE expires_at < NOW()
    AND is_active = true;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;

    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ================================
-- GRANTS AND PERMISSIONS
-- ================================

-- Grant permissions following existing pattern
GRANT SELECT, INSERT, UPDATE, DELETE ON stories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON story_views TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON story_likes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON story_comments TO authenticated;

-- Service role needs full access for system operations
GRANT ALL ON stories TO service_role;
GRANT ALL ON story_views TO service_role;
GRANT ALL ON story_likes TO service_role;
GRANT ALL ON story_comments TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;

COMMIT;