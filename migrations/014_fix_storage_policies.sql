-- Fix storage policies to work with anon key authentication
-- Run this in Supabase SQL Editor

-- Drop existing policies that might be conflicting
DROP POLICY IF EXISTS "Public Access" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload media" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own media" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own media" ON storage.objects;
DROP POLICY IF EXISTS "Public read access to media" ON storage.objects;

-- Create new permissive policies that work with anon key
-- Public read access for all media files
CREATE POLICY "Public read access to media" ON storage.objects FOR SELECT 
USING (bucket_id = 'media');

-- Allow anon key uploads to media bucket
CREATE POLICY "Allow anon uploads to media bucket" ON storage.objects FOR INSERT 
WITH CHECK (bucket_id = 'media');

-- Allow anon key updates to media bucket
CREATE POLICY "Allow anon updates to media bucket" ON storage.objects FOR UPDATE 
WITH CHECK (bucket_id = 'media');

-- Allow anon key deletes from media bucket
CREATE POLICY "Allow anon deletes from media bucket" ON storage.objects FOR DELETE 
USING (bucket_id = 'media');