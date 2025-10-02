-- Fix RLS policies for live_stream_comments and live_stream_reactions
-- Issue: Comment posting and reaction sending failing due to RLS policy violations
-- Solution: Create permissive policies for authenticated users

BEGIN;

-- =====================
-- Fix live_stream_comments RLS
-- =====================

-- Drop existing restrictive policies
DROP POLICY IF EXISTS "Anyone can view stream comments" ON live_stream_comments;
DROP POLICY IF EXISTS "Users can manage their own comments" ON live_stream_comments;
DROP POLICY IF EXISTS "Stream vendors can manage comments on their streams" ON live_stream_comments;

-- Create new permissive policies
-- Allow anyone to view non-deleted comments
CREATE POLICY "Anyone can view stream comments" ON live_stream_comments
FOR SELECT USING (is_deleted = false);

-- Allow authenticated users to post comments (insert)
CREATE POLICY "Authenticated users can post comments" ON live_stream_comments
FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Allow users to manage their own comments (update/delete)
CREATE POLICY "Users can manage their own comments" ON live_stream_comments
FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own comments" ON live_stream_comments
FOR DELETE USING (auth.uid() = user_id);

-- Allow stream vendors to moderate comments on their streams
CREATE POLICY "Stream vendors can moderate comments" ON live_stream_comments
FOR UPDATE USING (
    EXISTS (
        SELECT 1 FROM live_streams
        WHERE id = stream_id
        AND vendor_id = auth.uid()
    )
);

-- =====================
-- Fix live_stream_reactions RLS
-- =====================

-- Drop existing restrictive policies
DROP POLICY IF EXISTS "Anyone can view stream reactions" ON live_stream_reactions;
DROP POLICY IF EXISTS "Users can manage their own reactions" ON live_stream_reactions;

-- Create new permissive policies
-- Allow anyone to view reactions
CREATE POLICY "Anyone can view stream reactions" ON live_stream_reactions
FOR SELECT USING (true);

-- Allow authenticated users to send reactions (insert)
CREATE POLICY "Authenticated users can send reactions" ON live_stream_reactions
FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Allow users to manage their own reactions (update/delete)
CREATE POLICY "Users can manage their own reactions" ON live_stream_reactions
FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own reactions" ON live_stream_reactions
FOR DELETE USING (auth.uid() = user_id);

-- =====================
-- Ensure RLS is enabled
-- =====================

ALTER TABLE live_stream_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_stream_reactions ENABLE ROW LEVEL SECURITY;

COMMIT;