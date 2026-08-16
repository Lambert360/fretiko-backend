-- Temporary Migration: Create test job listing
-- Date: 2026-04-10
-- Description: Create a temporary job listing for testing careers form

-- Insert a test job listing
INSERT INTO job_listings (
    id,
    title,
    description,
    requirements,
    location,
    type,
    department,
    salary,
    status,
    created_at,
    updated_at
) VALUES (
    '00000000-0000-0000-0000-000000000000',
    'Senior React Developer',
    'We are looking for an experienced React Developer to join our team.',
    ARRAY['5+ years of React experience', 'TypeScript knowledge', 'Team collaboration'],
    'Remote',
    'full-time',
    'Engineering',
    '$80,000 - $120,000',
    'published',
    NOW(),
    NOW()
) ON CONFLICT (id) DO NOTHING;
