-- Fix comprehensive RLS policies for all live stream tables
-- MVP approach: Allow authenticated users to interact with live streams

BEGIN;

-- =====================
-- live_stream_comments Table RLS
-- =====================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view all comments" ON live_stream_comments;
DROP POLICY IF EXISTS "Users can post comments" ON live_stream_comments;
DROP POLICY IF EXISTS "Users can manage their own comments" ON live_stream_comments;

-- Create policies for live_stream_comments
-- Users can view all comments on any stream
CREATE POLICY "Users can view all comments" ON live_stream_comments
FOR SELECT USING (true);

-- Authenticated users can post comments
CREATE POLICY "Users can post comments" ON live_stream_comments
FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update/delete their own comments
CREATE POLICY "Users can manage their own comments" ON live_stream_comments
FOR ALL USING (auth.uid() = user_id);

-- Enable RLS
ALTER TABLE live_stream_comments ENABLE ROW LEVEL SECURITY;

-- =====================
-- live_stream_reactions Table RLS
-- =====================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view all reactions" ON live_stream_reactions;
DROP POLICY IF EXISTS "Users can send reactions" ON live_stream_reactions;
DROP POLICY IF EXISTS "Users can manage their own reactions" ON live_stream_reactions;

-- Create policies for live_stream_reactions
-- Users can view all reactions on any stream
CREATE POLICY "Users can view all reactions" ON live_stream_reactions
FOR SELECT USING (true);

-- Authenticated users can send reactions
CREATE POLICY "Users can send reactions" ON live_stream_reactions
FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update/delete their own reactions
CREATE POLICY "Users can manage their own reactions" ON live_stream_reactions
FOR ALL USING (auth.uid() = user_id);

-- Enable RLS
ALTER TABLE live_stream_reactions ENABLE ROW LEVEL SECURITY;

-- =====================
-- live_stream_gifts Table RLS (if exists)
-- =====================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view all gifts" ON live_stream_gifts;
DROP POLICY IF EXISTS "Users can send gifts" ON live_stream_gifts;
DROP POLICY IF EXISTS "Users can manage their own gifts" ON live_stream_gifts;

-- Create policies for live_stream_gifts
-- Users can view all gifts on any stream
CREATE POLICY "Users can view all gifts" ON live_stream_gifts
FOR SELECT USING (true);

-- Authenticated users can send gifts
CREATE POLICY "Users can send gifts" ON live_stream_gifts
FOR INSERT WITH CHECK (auth.uid() = sender_id);

-- Users can view their own gifts
CREATE POLICY "Users can manage their own gifts" ON live_stream_gifts
FOR ALL USING (auth.uid() = sender_id OR auth.uid() = recipient_id);

-- Enable RLS (this will fail if table doesn't exist, which is fine)
ALTER TABLE live_stream_gifts ENABLE ROW LEVEL SECURITY;

-- =====================
-- live_stream_viewers Table RLS (if exists)
-- =====================

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view stream viewers" ON live_stream_viewers;
DROP POLICY IF EXISTS "Users can join/leave streams" ON live_stream_viewers;

-- Create policies for live_stream_viewers
-- Users can view viewers of any stream
CREATE POLICY "Users can view stream viewers" ON live_stream_viewers
FOR SELECT USING (true);

-- Users can join/leave streams (manage their own viewer records)
CREATE POLICY "Users can join/leave streams" ON live_stream_viewers
FOR ALL USING (auth.uid() = user_id);

-- Enable RLS (this will fail if table doesn't exist, which is fine)
ALTER TABLE live_stream_viewers ENABLE ROW LEVEL SECURITY;

COMMIT;