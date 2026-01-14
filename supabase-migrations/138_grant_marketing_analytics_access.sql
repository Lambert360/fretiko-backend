-- =====================================================
-- GRANT MARKETING DEPARTMENT ANALYTICS ACCESS
-- =====================================================
-- Marketing needs to see platform statistics for campaign planning
-- but should NOT have access to revenue data (that's Finance only)

BEGIN;

-- Ensure Marketing department has view_platform_stats permission
UPDATE departments 
SET permissions = '[
    "view_users", "view_orders",
    "view_products", "view_services",
    "view_platform_stats",
    "export_data",
    "send_memos", "view_memos",
    "create_reports", "view_reports"
]'::jsonb,
updated_at = NOW()
WHERE slug = 'marketing';

-- Verify Marketing has the permission but NOT view_revenue
DO $$
DECLARE
    marketing_perms JSONB;
BEGIN
    SELECT permissions INTO marketing_perms
    FROM departments
    WHERE slug = 'marketing';
    
    -- Check if Marketing has view_platform_stats
    IF NOT (marketing_perms ? 'view_platform_stats') THEN
        RAISE EXCEPTION 'Marketing department missing view_platform_stats permission';
    END IF;
    
    -- Verify Marketing does NOT have view_revenue (finance-only permission)
    IF (marketing_perms ? 'view_revenue') THEN
        RAISE EXCEPTION 'Marketing should not have view_revenue permission';
    END IF;
    
    RAISE NOTICE '✅ Marketing department has analytics access without revenue permissions';
END $$;

COMMIT;

-- =====================================================
-- VERIFICATION QUERIES
-- =====================================================

-- Show Marketing department permissions
SELECT 
    name,
    slug,
    permissions,
    updated_at
FROM departments
WHERE slug = 'marketing';

COMMENT ON TABLE departments IS 'Departments - Marketing has analytics access without revenue data (v138)';

