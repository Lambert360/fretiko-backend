-- =====================================================
-- FRETIKO INTERNAL TOOL: DEPARTMENTS TABLE
-- =====================================================
-- This migration creates the departments table for the internal admin tool
-- Departments: Admin & Moderators, Customer Care, Logistics, HR, Finance

-- Create departments table
CREATE TABLE IF NOT EXISTS public.departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    permissions JSONB DEFAULT '[]'::jsonb,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create index on slug for faster lookups
CREATE INDEX IF NOT EXISTS idx_departments_slug ON public.departments(slug);
CREATE INDEX IF NOT EXISTS idx_departments_is_active ON public.departments(is_active);

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_departments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER departments_updated_at
    BEFORE UPDATE ON public.departments
    FOR EACH ROW
    EXECUTE FUNCTION update_departments_updated_at();

-- Insert default departments
INSERT INTO public.departments (name, slug, description, permissions) VALUES
(
    'Admin & Moderators',
    'admin_moderators',
    'Platform content moderation, user management, and policy enforcement',
    '[
        "view_users", "suspend_users", "delete_users",
        "view_products", "approve_products", "remove_products",
        "view_services", "approve_services", "remove_services",
        "view_stories", "remove_stories",
        "view_live_streams", "end_live_streams",
        "view_disputes",
        "view_platform_stats",
        "send_memos", "view_memos", "create_reports", "view_reports"
    ]'::jsonb
),
(
    'Customer Care',
    'customer_care',
    'User support, complaint resolution, and customer satisfaction',
    '[
        "view_users", "view_orders",
        "view_disputes", "create_reports",
        "send_memos", "view_memos", "view_reports"
    ]'::jsonb
),
(
    'Logistics',
    'logistics',
    'Rider management, delivery coordination, and shipping operations',
    '[
        "view_riders", "manage_riders",
        "view_deliveries", "assign_deliveries",
        "view_orders",
        "view_platform_stats",
        "send_memos", "view_memos", "create_reports", "view_reports"
    ]'::jsonb
),
(
    'HR',
    'hr',
    'Staff management, recruitment, performance reviews, and training',
    '[
        "create_staff", "edit_staff", "delete_staff", "assign_permissions",
        "view_staff_logs",
        "manage_departments",
        "send_memos", "view_memos", "create_reports", "view_reports"
    ]'::jsonb
),
(
    'Finance',
    'finance',
    'Revenue tracking, payouts, escrow management, and financial operations',
    '[
        "view_revenue", "view_wallet_transactions",
        "process_payouts", "manage_escrow",
        "view_orders", "view_transactions",
        "manage_refunds",
        "resolve_disputes",
        "view_platform_stats", "export_data",
        "send_memos", "view_memos", "create_reports", "view_reports"
    ]'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

-- Enable RLS
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Only staff can view departments
CREATE POLICY "Staff can view departments"
    ON public.departments
    FOR SELECT
    USING (true); -- Will be restricted by staff authentication

-- Only super_admin can modify departments
CREATE POLICY "Super admin can manage departments"
    ON public.departments
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE staff_accounts.id = auth.uid()
            AND staff_accounts.role = 'super_admin'
            AND staff_accounts.is_active = true
        )
    );

COMMENT ON TABLE public.departments IS 'Departments for the internal admin tool with role-based permissions';
COMMENT ON COLUMN public.departments.permissions IS 'JSONB array of permission codes assigned to this department';
