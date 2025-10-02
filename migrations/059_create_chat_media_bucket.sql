-- Create chat-media storage bucket for chat file uploads
-- Run this in Supabase SQL Editor

BEGIN;

-- Create the chat-media bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-media',
  'chat-media',
  true,
  104857600, -- 100MB limit
  ARRAY[
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
    'video/mp4', 'video/mov', 'video/avi', 'video/webm', 'video/quicktime',
    'audio/mp3', 'audio/wav', 'audio/m4a', 'audio/ogg', 'audio/mpeg',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain'
  ]
)
ON CONFLICT (id) DO NOTHING;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Public read access to chat media" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload chat media" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own chat media" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own chat media" ON storage.objects;

-- Create RLS policies for chat-media bucket
CREATE POLICY "Public read access to chat media" ON storage.objects
FOR SELECT USING (bucket_id = 'chat-media');

CREATE POLICY "Authenticated users can upload chat media" ON storage.objects
FOR INSERT WITH CHECK (
  bucket_id = 'chat-media' AND
  auth.role() = 'authenticated'
);

CREATE POLICY "Users can update own chat media" ON storage.objects
FOR UPDATE WITH CHECK (
  bucket_id = 'chat-media' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can delete own chat media" ON storage.objects
FOR DELETE USING (
  bucket_id = 'chat-media' AND
  auth.uid()::text = (storage.foldername(name))[1]
);

COMMIT;
