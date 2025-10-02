-- Create storage buckets for media uploads
-- Run this in Supabase SQL Editor

-- Create a bucket for general media (images and videos)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'media',
  'media',
  true,
  52428800, -- 50MB limit
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime', 'video/x-msvideo']
);

-- Create RLS policies for the media bucket
CREATE POLICY "Public Access" ON storage.objects FOR SELECT USING (bucket_id = 'media');

CREATE POLICY "Authenticated users can upload media" ON storage.objects FOR INSERT 
WITH CHECK (bucket_id = 'media' AND auth.role() = 'authenticated');

CREATE POLICY "Users can update own media" ON storage.objects FOR UPDATE 
WITH CHECK (bucket_id = 'media' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "Users can delete own media" ON storage.objects FOR DELETE 
USING (bucket_id = 'media' AND auth.uid()::text = (storage.foldername(name))[1]);

-- Create a function to generate unique file names
CREATE OR REPLACE FUNCTION generate_unique_filename(file_extension text)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN auth.uid()::text || '/' || gen_random_uuid()::text || '.' || file_extension;
END;
$$;