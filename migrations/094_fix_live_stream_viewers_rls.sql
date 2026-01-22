-- Migration: Fix Live Stream Viewers RLS Policy
-- Date: 2026-01-19
-- Description: Ensure RLS policies allow authenticated users to insert their own viewer records
--
-- Issue: Users were getting "new row violates row-level security policy" when joining streams
-- This migration ensures the policy explicitly allows INSERT operations for authenticated users
-- Following the pattern established in migration 053_fix_live_stream_comments_reactions_rls.sql

BEGIN;

-- =====================
-- Fix live_stream_viewers RLS
-- =====================

-- Drop existing restrictive policy
DROP POLICY IF EXISTS "Users can manage their own viewer records" ON live_stream_viewers;

-- The SELECT policy already exists and is fine, so we keep it
-- CREATE POLICY "Anyone can view stream viewers" ON live_stream_viewers FOR SELECT USING (true);

-- Allow authenticated users to insert their own viewer records (join streams)
CREATE POLICY "Authenticated users can join streams" ON live_stream_viewers
FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Allow users to update their own viewer records (update left_at timestamp)
CREATE POLICY "Users can update their own viewer records" ON live_stream_viewers
FOR UPDATE USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Allow users to delete their own viewer records (cleanup)
CREATE POLICY "Users can delete their own viewer records" ON live_stream_viewers
FOR DELETE USING (auth.uid() = user_id);

-- Ensure RLS is enabled
ALTER TABLE live_stream_viewers ENABLE ROW LEVEL SECURITY;

COMMIT;

