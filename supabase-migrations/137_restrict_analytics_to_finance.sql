-- =====================================================
-- RESTRICT ANALYTICS ACCESS TO FINANCE DEPARTMENT ONLY
-- =====================================================
-- Security Fix: Remove view_platform_stats from Admin & Moderators and Logistics
-- Only Finance department should have access to platform statistics and analytics
-- Super admins retain access through role-based checks

BEGIN;

-- Update Admin & Moderators department - Remove view_platform_stats
UPDATE departments 
SET permissions = '[
    "view_users", "suspend_users", "delete_users",
    "view_products", "approve_products", "remove_products",
    "view_services", "approve_services", "remove_services",
    "view_stories", "remove_stories",
    "view_live_streams", "end_live_streams",
    "view_disputes",
    "send_memos", "view_memos", "create_reports", "view_reports"
]'::jsonb,
updated_at = NOW()
WHERE slug = 'admin_moderators';

-- Update Logistics department - Remove view_platform_stats
UPDATE departments 
SET permissions = '[
    "view_riders", "manage_riders",
    "view_deliveries", "assign_deliveries",
    "view_orders",
    "send_memos", "view_memos", "create_reports", "view_reports"
]'::jsonb,
updated_at = NOW()
WHERE slug = 'logistics';

-- Verify Finance department still has both permissions
-- (Should already have them, this is just verification)
DO $$
DECLARE
    finance_perms JSONB;
BEGIN
    SELECT permissions INTO finance_perms
    FROM departments
    WHERE slug = 'finance';
    
    -- Check if Finance has required permissions
    IF NOT (finance_perms ? 'view_platform_stats' AND finance_perms ? 'view_revenue') THEN
        RAISE EXCEPTION 'Finance department missing required permissions';
    END IF;
    
    RAISE NOTICE '✅ Finance department permissions verified';
END $$;

COMMIT;

-- =====================================================
-- VERIFICATION QUERIES
-- =====================================================

-- Show updated permissions for all departments
SELECT 
    name,
    slug,
    permissions,
    updated_at
FROM departments
WHERE slug IN ('admin_moderators', 'logistics', 'finance')
ORDER BY 
    CASE 
        WHEN slug = 'finance' THEN 1
        WHEN slug = 'admin_moderators' THEN 2
        WHEN slug = 'logistics' THEN 3
    END;

COMMENT ON TABLE departments IS 'Departments for internal admin tool - Analytics access restricted to Finance only (v137)';

