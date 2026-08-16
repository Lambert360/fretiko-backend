-- Migration: Create Posts Media Storage RLS Policies
-- Created: 2025-01-08
-- Purpose: RLS policies for posts-media bucket
-- IMPORTANT: Create the 'posts-media' bucket via Supabase Dashboard first!
--   - Go to Storage → New bucket
--   - Name: posts-media
--   - Public: true
--   - File size limit: 50MB
--   - Allowed MIME types: image/jpeg, image/png, image/gif, image/webp, video/mp4, video/quicktime, video/webm

-- Only run policies if bucket exists (will error otherwise)

-- Create RLS policies for posts-media bucket
-- Public can view posts media (posts are public by default)
CREATE POLICY "Public read access to posts media" ON storage.objects
FOR SELECT USING (bucket_id = 'posts-media');

-- Authenticated users can upload their own posts media
-- Files organized by user_id/post_id/filename
CREATE POLICY "Authenticated users can upload posts media" ON storage.objects
FOR INSERT WITH CHECK (
  bucket_id = 'posts-media' AND
  auth.role() = 'authenticated' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

-- Users can update their own posts media
CREATE POLICY "Users can update own posts media" ON storage.objects
FOR UPDATE USING (
  bucket_id = 'posts-media' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

-- Users can delete their own posts media
CREATE POLICY "Users can delete own posts media" ON storage.objects
FOR DELETE USING (
  bucket_id = 'posts-media' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

-- Grant necessary permissions (these may also require elevated privileges)
-- If these fail, set permissions via Dashboard → Storage → Policies
