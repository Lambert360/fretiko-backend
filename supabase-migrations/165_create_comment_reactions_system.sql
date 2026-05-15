-- Migration: Create Comment Reactions System
-- Date: 2025-05-10
-- Description: Add tables for comment likes and gifts, extend post_interactions with counters
--              This enables users to like and send gifts to individual comments

-- ============================================
-- 1. EXTEND POST_INTERACTIONS TABLE
-- ============================================
-- Add counters to comments (post_interactions with interaction_type = 'comment')
ALTER TABLE post_interactions 
ADD COLUMN IF NOT EXISTS likes_count INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS gifts_count INTEGER NOT NULL DEFAULT 0;

-- Add comments explaining the new columns
COMMENT ON COLUMN post_interactions.likes_count IS 'Number of likes on this comment (only applicable when interaction_type = "comment")';
COMMENT ON COLUMN post_interactions.gifts_count IS 'Number of gifts received on this comment (only applicable when interaction_type = "comment")';

-- ============================================
-- 2. CREATE COMMENT LIKES TABLE
-- ============================================
-- Track which users liked which comments
CREATE TABLE IF NOT EXISTS comment_likes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    comment_id UUID NOT NULL REFERENCES post_interactions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    
    -- Prevent duplicate likes per user per comment
    UNIQUE(comment_id, user_id)
);

-- Add table comment
COMMENT ON TABLE comment_likes IS 'Tracks user likes on comments (post_interactions records with interaction_type = "comment")';

-- ============================================
-- 3. CREATE COMMENT GIFTS TABLE
-- ============================================
-- Track gifts sent to comments
CREATE TABLE IF NOT EXISTS comment_gifts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    comment_id UUID NOT NULL REFERENCES post_interactions(id) ON DELETE CASCADE,
    from_user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    to_user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE, -- Comment author
    gift_id UUID NOT NULL REFERENCES virtual_gifts(id) ON DELETE CASCADE,
    gift_value DECIMAL(10,2) NOT NULL, -- Store the value at time of gifting
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Add table comment
COMMENT ON TABLE comment_gifts IS 'Tracks gifts sent to comments by users';

-- ============================================
-- 4. CREATE INDEXES FOR PERFORMANCE
-- ============================================
-- Indexes for comment_likes
CREATE INDEX IF NOT EXISTS idx_comment_likes_comment_id ON comment_likes(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_likes_user_id ON comment_likes(user_id);
CREATE INDEX IF NOT EXISTS idx_comment_likes_created_at ON comment_likes(created_at DESC);

-- Indexes for comment_gifts
CREATE INDEX IF NOT EXISTS idx_comment_gifts_comment_id ON comment_gifts(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_gifts_from_user ON comment_gifts(from_user_id);
CREATE INDEX IF NOT EXISTS idx_comment_gifts_to_user ON comment_gifts(to_user_id);
CREATE INDEX IF NOT EXISTS idx_comment_gifts_gift_id ON comment_gifts(gift_id);
CREATE INDEX IF NOT EXISTS idx_comment_gifts_created_at ON comment_gifts(created_at DESC);

-- Indexes for sorting comments by popularity
CREATE INDEX IF NOT EXISTS idx_post_interactions_likes_count ON post_interactions(likes_count DESC) WHERE interaction_type = 'comment';
CREATE INDEX IF NOT EXISTS idx_post_interactions_gifts_count ON post_interactions(gifts_count DESC) WHERE interaction_type = 'comment';
CREATE INDEX IF NOT EXISTS idx_post_interactions_comment_score ON post_interactions((likes_count + gifts_count * 5)) WHERE interaction_type = 'comment';

-- ============================================
-- 5. ENABLE ROW LEVEL SECURITY
-- ============================================
-- Enable RLS on new tables
ALTER TABLE comment_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_gifts ENABLE ROW LEVEL SECURITY;

-- RLS Policies for comment_likes
-- Anyone can view comment likes
CREATE POLICY "Comment likes are viewable by everyone" ON comment_likes
    FOR SELECT USING (TRUE);

-- Users can only like/unlike as themselves
CREATE POLICY "Users can create their own comment likes" ON comment_likes
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- Users can only delete their own likes
CREATE POLICY "Users can delete their own comment likes" ON comment_likes
    FOR DELETE USING (user_id = auth.uid());

-- RLS Policies for comment_gifts
-- Anyone can view comment gifts
CREATE POLICY "Comment gifts are viewable by everyone" ON comment_gifts
    FOR SELECT USING (TRUE);

-- Users can only send gifts as themselves
CREATE POLICY "Users can send gifts to comments" ON comment_gifts
    FOR INSERT WITH CHECK (from_user_id = auth.uid());

-- ============================================
-- 6. CREATE TRIGGERS FOR COUNT UPDATES
-- ============================================
-- Function to update comment likes_count when likes are added/removed
CREATE OR REPLACE FUNCTION update_comment_likes_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE post_interactions 
        SET likes_count = likes_count + 1 
        WHERE id = NEW.comment_id AND interaction_type = 'comment';
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE post_interactions 
        SET likes_count = GREATEST(0, likes_count - 1) 
        WHERE id = OLD.comment_id AND interaction_type = 'comment';
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger for comment likes count
DROP TRIGGER IF EXISTS comment_likes_count_trigger ON comment_likes;
CREATE TRIGGER comment_likes_count_trigger
    AFTER INSERT OR DELETE ON comment_likes
    FOR EACH ROW
    EXECUTE FUNCTION update_comment_likes_count();

-- Function to update comment gifts_count when gifts are added
CREATE OR REPLACE FUNCTION update_comment_gifts_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE post_interactions 
        SET gifts_count = gifts_count + 1 
        WHERE id = NEW.comment_id AND interaction_type = 'comment';
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Trigger for comment gifts count
DROP TRIGGER IF EXISTS comment_gifts_count_trigger ON comment_gifts;
CREATE TRIGGER comment_gifts_count_trigger
    AFTER INSERT ON comment_gifts
    FOR EACH ROW
    EXECUTE FUNCTION update_comment_gifts_count();

-- ============================================
-- 7. CREATE HELPER FUNCTIONS
-- ============================================
-- Function to check if user liked a comment
CREATE OR REPLACE FUNCTION has_user_liked_comment(p_comment_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM comment_likes 
        WHERE comment_id = p_comment_id AND user_id = p_user_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get comment score for ranking
-- Score = likes + (gifts * 5) - time_decay
CREATE OR REPLACE FUNCTION get_comment_score(p_comment_id UUID)
RETURNS DECIMAL AS $$
DECLARE
    v_likes INTEGER;
    v_gifts INTEGER;
    v_hours_since_post DECIMAL;
    v_score DECIMAL;
BEGIN
    SELECT likes_count, gifts_count, 
           EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600
    INTO v_likes, v_gifts, v_hours_since_post
    FROM post_interactions 
    WHERE id = p_comment_id AND interaction_type = 'comment';
    
    v_score := (v_likes * 1.0) + (v_gifts * 5.0) - (v_hours_since_post * 0.1);
    RETURN GREATEST(0, v_score);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 8. BACKFILL EXISTING DATA (if needed)
-- ============================================
-- Note: This migration assumes starting from scratch for comment reactions
-- If there is existing data to migrate, add backfill queries here

-- Example backfill (if needed in future):
-- UPDATE post_interactions 
-- SET likes_count = (SELECT COUNT(*) FROM comment_likes WHERE comment_id = post_interactions.id)
-- WHERE interaction_type = 'comment';

COMMIT;
