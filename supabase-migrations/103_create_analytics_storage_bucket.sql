-- Migration: Create analytics reports storage bucket
-- Description: Storage bucket for analytics reports (JSON, CSV, PDF, Excel files)
-- Date: 2025-01-XX
-- 
-- ⚠️ IMPORTANT: This migration requires admin/superuser permissions.
-- If it fails, create the bucket manually via Supabase Dashboard:
--   1. Go to Storage > Buckets
--   2. Create new bucket: "analytics-reports"
--   3. Set to Public: true
--   4. File size limit: 50MB
--   5. Allowed MIME types: application/json, text/csv, application/pdf, 
--      application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
--   6. Then run only the policies section below manually

-- ================================
-- STORAGE BUCKET CREATION
-- ================================

-- Attempt to create bucket (requires admin permissions)
-- This will fail gracefully if permissions aren't available
DO $$
BEGIN
  -- Check if bucket already exists
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets WHERE id = 'analytics-reports'
  ) THEN
    -- Try to insert bucket (requires admin permissions)
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'analytics-reports',
      'analytics-reports',
      true,
      52428800, -- 50MB in bytes
      ARRAY[
        'application/json',
        'text/csv',
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel'
      ]
    );
    RAISE NOTICE '✅ Created analytics-reports storage bucket';
  ELSE
    RAISE NOTICE 'ℹ️ analytics-reports bucket already exists, skipping creation';
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE WARNING '⚠️ Insufficient permissions to create bucket. Please create manually via Supabase Dashboard.';
  WHEN OTHERS THEN
    RAISE WARNING '⚠️ Error creating bucket: %. Bucket may need to be created manually.', SQLERRM;
END $$;

-- ================================
-- STORAGE POLICIES
-- ================================

-- Create storage policies (only if bucket exists and we have permissions)
-- This section will be skipped if permissions aren't available
DO $$
DECLARE
  v_bucket_exists BOOLEAN;
  v_has_permissions BOOLEAN;
BEGIN
  -- Check if bucket exists
  SELECT EXISTS(SELECT 1 FROM storage.buckets WHERE id = 'analytics-reports') INTO v_bucket_exists;
  
  IF NOT v_bucket_exists THEN
    RAISE WARNING '⚠️ Bucket analytics-reports does not exist. Create bucket first via Supabase Dashboard, then policies can be created.';
    RETURN;
  END IF;

  -- Check if we have permissions by trying to query pg_policies
  BEGIN
    PERFORM 1 FROM pg_policies WHERE schemaname = 'storage' LIMIT 1;
    v_has_permissions := true;
  EXCEPTION
    WHEN OTHERS THEN
      v_has_permissions := false;
  END;

  IF NOT v_has_permissions THEN
    RAISE WARNING '⚠️ Insufficient permissions to create storage policies. Please create manually via Supabase Dashboard.';
    RETURN;
  END IF;

  -- Try to drop existing policies (idempotent)
  BEGIN
    DROP POLICY IF EXISTS "Users can upload their own reports" ON storage.objects;
    DROP POLICY IF EXISTS "Users can read their own reports" ON storage.objects;
    DROP POLICY IF EXISTS "Users can delete their own reports" ON storage.objects;
    DROP POLICY IF EXISTS "Public can read reports" ON storage.objects;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING '⚠️ Could not drop existing policies (they may not exist). Continuing...';
  END;
  
  -- Create policies (wrapped in individual try-catch blocks)
  BEGIN
    CREATE POLICY "Users can upload their own reports"
    ON storage.objects FOR INSERT
    WITH CHECK (
      bucket_id = 'analytics-reports' AND
      auth.role() = 'authenticated' AND
      (storage.foldername(name))[1] = auth.uid()::text
    );
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING '⚠️ Could not create upload policy: %. Create manually.', SQLERRM;
  END;

  BEGIN
    CREATE POLICY "Users can read their own reports"
    ON storage.objects FOR SELECT
    USING (
      bucket_id = 'analytics-reports' AND
      (
        (storage.foldername(name))[1] = auth.uid()::text OR
        auth.role() = 'service_role'
      )
    );
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING '⚠️ Could not create read policy: %. Create manually.', SQLERRM;
  END;

  BEGIN
    CREATE POLICY "Users can delete their own reports"
    ON storage.objects FOR DELETE
    USING (
      bucket_id = 'analytics-reports' AND
      (storage.foldername(name))[1] = auth.uid()::text
    );
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING '⚠️ Could not create delete policy: %. Create manually.', SQLERRM;
  END;

  BEGIN
    CREATE POLICY "Public can read reports"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'analytics-reports');
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING '⚠️ Could not create public read policy: %. Create manually.', SQLERRM;
  END;
  
  RAISE NOTICE '✅ Attempted to create storage policies for analytics-reports bucket';
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING '⚠️ Error in storage policies section: %. Policies may need to be created manually via Supabase Dashboard.', SQLERRM;
END $$;

-- ================================
-- COMMENTS (Only if policies were created successfully)
-- ================================

DO $$
BEGIN
  -- Only add comments if policies exist
  IF EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'Users can upload their own reports'
  ) THEN
    COMMENT ON POLICY "Users can upload their own reports" ON storage.objects IS 
      'Allows users to upload analytics reports to their own folder';
    COMMENT ON POLICY "Users can read their own reports" ON storage.objects IS 
      'Allows users to read their own analytics reports';
    COMMENT ON POLICY "Public can read reports" ON storage.objects IS 
      'Allows public access to report download URLs';
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    -- Ignore comment errors
    NULL;
END $$;

