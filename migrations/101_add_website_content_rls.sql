-- Migration: Add Row Level Security (RLS) policies for website content tables
-- Date: 2026-04-03
-- Description: Secure website content management with proper RLS policies

-- Enable RLS on all website content tables
ALTER TABLE blog_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE about_content ENABLE ROW LEVEL SECURITY;

-- ===== BLOG_POSTS RLS POLICIES =====

-- Policy 1: All users can view published blog posts
CREATE POLICY "Users can view published blog posts" ON blog_posts
    FOR SELECT USING (
        status = 'published'
    );

-- Policy 2: Admin users can manage all blog posts
CREATE POLICY "Admin users can manage all blog posts" ON blog_posts
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts s
            JOIN public.departments d ON s.department_id = d.id
            WHERE s.id = auth.uid()
            AND s.is_active = true
            AND (
                s.role = 'super_admin' 
                OR (s.role = 'department_head' AND d.slug = 'admin_moderators')
            )
        )
    );

-- ===== JOB_LISTINGS RLS POLICIES =====

-- Policy 1: All users can view published job listings
CREATE POLICY "Users can view published job listings" ON job_listings
    FOR SELECT USING (
        status = 'published'
    );

-- Policy 2: Admin users can manage all job listings
CREATE POLICY "Admin users can manage all job listings" ON job_listings
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts s
                JOIN public.departments d ON s.department_id = d.id
                WHERE s.id = auth.uid()
                AND s.is_active = true
                AND (
                    s.role = 'super_admin' 
                    OR (s.role = 'department_head' AND d.slug IN ('admin_moderators', 'hr'))
                )
        )
    );

-- ===== JOB_APPLICATIONS RLS POLICIES =====

-- Policy 1: Admin users can view all job applications
CREATE POLICY "Admin users can view all job applications" ON job_applications
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts s
                JOIN public.departments d ON s.department_id = d.id
                WHERE s.id = auth.uid()
                AND s.is_active = true
                AND (
                    s.role = 'super_admin' 
                        OR (s.role = 'department_head' AND d.slug IN ('admin_moderators', 'hr'))
                )
        )
    );

-- Policy 2: Admin users can manage all job applications
CREATE POLICY "Admin users can manage all job applications" ON job_applications
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts s
                JOIN public.departments d ON s.department_id = d.id
                WHERE s.id = auth.uid()
                AND s.is_active = true
                AND (
                    s.role = 'super_admin' 
                        OR (s.role = 'department_head' AND d.slug IN ('admin_moderators', 'hr'))
                )
        )
    );

-- ===== ABOUT_CONTENT RLS POLICIES =====

-- Policy 1: All users can view active about content
CREATE POLICY "Users can view active about content" ON about_content
    FOR SELECT USING (
        is_active = true
    );

-- Policy 2: Admin users can manage all about content
CREATE POLICY "Admin users can manage all about content" ON about_content
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts s
                JOIN public.departments d ON s.department_id = d.id
                WHERE s.id = auth.uid()
                AND s.is_active = true
                AND (
                    s.role = 'super_admin' 
                        OR (s.role = 'department_head' AND d.slug = 'admin_moderators')
                )
        )
    );

-- Grant service role permissions for API access
GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON blog_posts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON job_listings TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON job_applications TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON about_content TO service_role;

-- Note: Sequence grants removed - tables use UUID primary keys with gen_random_uuid()

-- Add comments as regular comments since PostgreSQL doesn't support COMMENT ON POLICY
-- Policy: "Users can view published blog posts" - Allows public access to published blog posts
-- Policy: "Admin users can manage all blog posts" - Allows admin users full CRUD access
-- Policy: "Users can view published job listings" - Allows public access to published job listings
-- Policy: "Admin users can manage all job listings" - Allows admin users full CRUD access
-- Policy: "Admin users can view all job applications" - Allows admin users to view all applications
-- Policy: "Admin users can manage all job applications" - Allows admin users full CRUD access
-- Policy: "Users can view active about content" - Allows public access to active about sections
-- Policy: "Admin users can manage all about content" - Allows admin users full CRUD access
