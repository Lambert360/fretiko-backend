-- Migration: Create website-content storage bucket and policies
-- Description: Creates storage bucket for website content images and files
-- Created: 2025-04-09

-- Create the website-content storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'website-content',
  'website-content',
  true,
  52428800, -- 50MB in bytes
  ARRAY[
    'image/jpeg',
    'image/jpg', 
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
) ON CONFLICT (id) DO NOTHING;

-- Storage bucket structure documentation:
-- website-content/
--   blog-images/           # Blog post featured images
--   about-images/          # About section images
--   career-images/          # Career page images
--   job-listings/          # Job listing company logos
--   job-applications/       # Application files
--     resume/           # Resume files (PDF, DOC)
--     portfolio/          # Portfolio images

-- Grant necessary permissions for storage
GRANT ALL ON storage.objects TO authenticated;
GRANT SELECT ON storage.objects TO anon;
GRANT INSERT ON storage.objects TO anon; -- Allow anonymous uploads for job applications
GRANT ALL ON storage.objects TO service_role;

-- Migration completed
-- Supabase automatically tracks migration execution
