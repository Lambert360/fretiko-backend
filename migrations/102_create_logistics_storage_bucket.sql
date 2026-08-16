-- Migration: Create storage bucket for logistics partnership documents
-- Date: 2026-04-05
-- Description: Create Supabase storage buckets for partnership documents and logos

-- Create storage bucket for partnership documents
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'partnership-documents', 
  'partnership-documents', 
  false, 
  10485760, -- 10MB limit
  ARRAY[
    'image/jpeg',
    'image/jpg', 
    'image/png',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
) ON CONFLICT (id) DO NOTHING;

-- Create storage bucket for company logos
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'company-logos', 
  'company-logos', 
  true, -- Public bucket for logos
  2097152, -- 2MB limit
  ARRAY[
    'image/jpeg',
    'image/jpg', 
    'image/png',
    'image/gif',
    'image/webp'
  ]
) ON CONFLICT (id) DO NOTHING;

-- Row Level Security Policies for partnership documents
-- Allow anonymous users to upload documents (for partnership applications)
CREATE POLICY "Allow anonymous uploads to partnership documents" ON storage.objects
FOR INSERT WITH CHECK (
  bucket_id = 'partnership-documents' AND 
  auth.role() = 'anon'
);

-- Allow service role to manage all partnership documents
CREATE POLICY "Allow service role full access to partnership documents" ON storage.objects
FOR ALL USING (
  bucket_id = 'partnership-documents' AND 
  auth.role() = 'service_role'
);

-- Allow public read access to partnership documents (for admin review)
CREATE POLICY "Allow public read access to partnership documents" ON storage.objects
FOR SELECT USING (
  bucket_id = 'partnership-documents' AND 
  auth.role() = 'service_role'
);

-- Row Level Security Policies for company logos
-- Allow anonymous users to upload logos (for partnership applications)
CREATE POLICY "Allow anonymous uploads to company logos" ON storage.objects
FOR INSERT WITH CHECK (
  bucket_id = 'company-logos' AND 
  auth.role() = 'anon'
);

-- Allow service role to manage all company logos
CREATE POLICY "Allow service role full access to company logos" ON storage.objects
FOR ALL USING (
  bucket_id = 'company-logos' AND 
  auth.role() = 'service_role'
);

-- Allow public read access to company logos (logos should be publicly visible)
CREATE POLICY "Allow public read access to company logos" ON storage.objects
FOR SELECT USING (
  bucket_id = 'company-logos'
);

-- Grant permissions to service role
GRANT ALL ON storage.buckets TO service_role;
GRANT ALL ON storage.objects TO service_role;

-- Grant select permissions to anonymous users for public buckets
GRANT SELECT ON storage.buckets TO anon;
GRANT SELECT ON storage.objects TO anon;
