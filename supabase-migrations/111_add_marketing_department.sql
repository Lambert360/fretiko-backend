-- =====================================================
-- ADD MARKETING DEPARTMENT
-- =====================================================
-- Adds the Marketing department to the departments table

INSERT INTO public.departments (name, slug, description, permissions) VALUES
(
    'Marketing',
    'marketing',
    'Brand promotion, campaigns, social media management, and customer acquisition',
    '[
        "view_users", "view_orders",
        "view_products", "view_services",
        "view_platform_stats", "export_data",
        "send_memos", "view_memos",
        "create_reports", "view_reports"
    ]'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

COMMENT ON TABLE public.departments IS 'Departments for the internal admin tool with role-based permissions';

