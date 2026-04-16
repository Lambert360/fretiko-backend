-- Migration: Add logistics partnership permissions
-- Date: 2026-03-22
-- Description: Add new permissions for logistics partnership management

-- Note: staff_accounts table already exists in Supabase migrations (105_create_internal_tool_staff_accounts.sql)
-- The existing table does NOT have a permissions column - permissions are handled through departments table
-- We'll add logistics permissions to departments table instead

-- First, try to update existing logistics department
UPDATE public.departments 
SET permissions = COALESCE(permissions, '[]'::jsonb) || '["view_partner_applications","verify_logistics_partners","view_verified_partners","manage_verified_partners","view_rider_verifications","verify_riders","manage_verified_riders"]'::jsonb,
    updated_at = NOW()
WHERE slug = 'logistics';

-- Insert logistics department only if it doesn't exist
INSERT INTO public.departments (id, name, slug, permissions, created_at, updated_at)
VALUES (
    gen_random_uuid(),
    'Logistics Department',
    'logistics',
    '["view_partner_applications","verify_logistics_partners","view_verified_partners","manage_verified_partners","view_rider_verifications","verify_riders","manage_verified_riders"]'::jsonb,
    NOW(),
    NOW()
) ON CONFLICT (slug) DO NOTHING;

COMMIT;
