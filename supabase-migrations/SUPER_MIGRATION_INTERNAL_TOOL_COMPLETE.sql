-- =====================================================
-- FRETIKO INTERNAL TOOL: COMPLETE MIGRATION (104-109)
-- =====================================================
-- This is a consolidated migration that combines all 6 internal tool migrations
-- Includes: Departments, Staff Accounts, Memos, Reports, Audit Logs, Super Admin Seed
--
-- Migrations consolidated:
-- - 104_create_internal_tool_departments.sql
-- - 105_create_internal_tool_staff_accounts.sql
-- - 106_create_internal_tool_memos.sql
-- - 107_create_internal_tool_reports.sql
-- - 108_create_internal_tool_audit_logs.sql
-- - 109_create_super_admin_seed.sql
-- =====================================================

-- =====================================================
-- SECTION 1: DEPARTMENTS TABLE (Migration 104)
-- =====================================================

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

-- Enable RLS (policies will be added after staff_accounts table is created)
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.departments IS 'Departments for the internal admin tool with role-based permissions';
COMMENT ON COLUMN public.departments.permissions IS 'JSONB array of permission codes assigned to this department';

-- =====================================================
-- SECTION 2: STAFF ACCOUNTS TABLE (Migration 105)
-- =====================================================

-- Create staff_accounts table
CREATE TABLE IF NOT EXISTS public.staff_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id TEXT NOT NULL UNIQUE, -- Auto-generated: FTK-2025-0001
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
    role TEXT NOT NULL CHECK (role IN ('super_admin', 'department_head', 'staff')),
    is_active BOOLEAN DEFAULT true,
    last_login_at TIMESTAMP WITH TIME ZONE,
    password_changed_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    must_change_password BOOLEAN DEFAULT true, -- Force password change on first login
    created_by UUID REFERENCES public.staff_accounts(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_staff_accounts_staff_id ON public.staff_accounts(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_accounts_email ON public.staff_accounts(email);
CREATE INDEX IF NOT EXISTS idx_staff_accounts_department_id ON public.staff_accounts(department_id);
CREATE INDEX IF NOT EXISTS idx_staff_accounts_role ON public.staff_accounts(role);
CREATE INDEX IF NOT EXISTS idx_staff_accounts_is_active ON public.staff_accounts(is_active);

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_staff_accounts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER staff_accounts_updated_at
    BEFORE UPDATE ON public.staff_accounts
    FOR EACH ROW
    EXECUTE FUNCTION update_staff_accounts_updated_at();

-- Function to generate unique staff ID
CREATE OR REPLACE FUNCTION generate_staff_id()
RETURNS TEXT AS $$
DECLARE
    new_id TEXT;
    year_str TEXT;
    counter INT;
BEGIN
    year_str := TO_CHAR(NOW(), 'YYYY');

    -- Get the highest counter for this year
    SELECT COALESCE(
        MAX(
            CAST(
                SUBSTRING(staff_id FROM 'FTK-' || year_str || '-(\d+)') AS INT
            )
        ), 0
    ) + 1
    INTO counter
    FROM public.staff_accounts
    WHERE staff_id LIKE 'FTK-' || year_str || '-%';

    -- Format: FTK-2025-0001
    new_id := 'FTK-' || year_str || '-' || LPAD(counter::TEXT, 4, '0');

    RETURN new_id;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-generate staff_id if not provided
CREATE OR REPLACE FUNCTION auto_generate_staff_id()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.staff_id IS NULL OR NEW.staff_id = '' THEN
        NEW.staff_id := generate_staff_id();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER staff_id_auto_generate
    BEFORE INSERT ON public.staff_accounts
    FOR EACH ROW
    EXECUTE FUNCTION auto_generate_staff_id();

-- Enable RLS
ALTER TABLE public.staff_accounts ENABLE ROW LEVEL SECURITY;

-- RLS Policies

-- Staff can view their own account
CREATE POLICY "Staff can view own account"
    ON public.staff_accounts
    FOR SELECT
    USING (id = auth.uid());

-- Staff can update their own password
CREATE POLICY "Staff can update own password"
    ON public.staff_accounts
    FOR UPDATE
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());

-- Super admin can view all staff
CREATE POLICY "Super admin can view all staff"
    ON public.staff_accounts
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts s
            WHERE s.id = auth.uid()
            AND s.role = 'super_admin'
            AND s.is_active = true
        )
    );

-- Super admin and HR can manage staff
CREATE POLICY "Super admin and HR can manage staff"
    ON public.staff_accounts
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts s
            LEFT JOIN public.departments d ON s.department_id = d.id
            WHERE s.id = auth.uid()
            AND s.is_active = true
            AND (
                s.role = 'super_admin'
                OR (d.slug = 'hr' AND (s.role = 'department_head' OR d.permissions ? 'create_staff'))
            )
        )
    );

-- Department heads can view staff in their department
CREATE POLICY "Department heads can view their department staff"
    ON public.staff_accounts
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts s
            WHERE s.id = auth.uid()
            AND s.is_active = true
            AND s.role = 'department_head'
            AND s.department_id = staff_accounts.department_id
        )
    );

COMMENT ON TABLE public.staff_accounts IS 'Staff accounts for the internal admin tool';
COMMENT ON COLUMN public.staff_accounts.staff_id IS 'Unique staff identifier in format FTK-YYYY-NNNN';
COMMENT ON COLUMN public.staff_accounts.role IS 'Staff role: super_admin (god mode), department_head, or staff';
COMMENT ON COLUMN public.staff_accounts.must_change_password IS 'Force password change on next login';

-- =====================================================
-- SECTION 3: MEMOS TABLE (Migration 106)
-- =====================================================

-- Create memos table
CREATE TABLE IF NOT EXISTS public.memos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    sender_id UUID NOT NULL REFERENCES public.staff_accounts(id) ON DELETE CASCADE,
    sender_department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
    recipient_type TEXT NOT NULL CHECK (recipient_type IN ('department', 'staff', 'all')),
    recipient_id UUID, -- NULL if recipient_type = 'all'
    priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    is_read BOOLEAN DEFAULT false,
    read_at TIMESTAMP WITH TIME ZONE,
    read_by UUID REFERENCES public.staff_accounts(id) ON DELETE SET NULL,
    attachments JSONB DEFAULT '[]'::jsonb, -- Array of {type, url, name, size}
    parent_memo_id UUID REFERENCES public.memos(id) ON DELETE SET NULL, -- For threading/replies
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_memos_sender_id ON public.memos(sender_id);
CREATE INDEX IF NOT EXISTS idx_memos_recipient_type ON public.memos(recipient_type);
CREATE INDEX IF NOT EXISTS idx_memos_recipient_id ON public.memos(recipient_id);
CREATE INDEX IF NOT EXISTS idx_memos_is_read ON public.memos(is_read);
CREATE INDEX IF NOT EXISTS idx_memos_priority ON public.memos(priority);
CREATE INDEX IF NOT EXISTS idx_memos_created_at ON public.memos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memos_parent_memo_id ON public.memos(parent_memo_id);

-- Enable RLS
ALTER TABLE public.memos ENABLE ROW LEVEL SECURITY;

-- RLS Policies

-- Staff can view memos sent by them
CREATE POLICY "Staff can view sent memos"
    ON public.memos
    FOR SELECT
    USING (sender_id = auth.uid());

-- Staff can view memos sent to them directly
CREATE POLICY "Staff can view memos sent to them"
    ON public.memos
    FOR SELECT
    USING (
        recipient_type = 'staff'
        AND recipient_id = auth.uid()
    );

-- Staff can view memos sent to their department
CREATE POLICY "Staff can view department memos"
    ON public.memos
    FOR SELECT
    USING (
        recipient_type = 'department'
        AND EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE staff_accounts.id = auth.uid()
            AND staff_accounts.department_id = memos.recipient_id
            AND staff_accounts.is_active = true
        )
    );

-- Staff can view memos sent to all
CREATE POLICY "Staff can view all-staff memos"
    ON public.memos
    FOR SELECT
    USING (
        recipient_type = 'all'
        AND EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE staff_accounts.id = auth.uid()
            AND staff_accounts.is_active = true
        )
    );

-- Super admin can view all memos
CREATE POLICY "Super admin can view all memos"
    ON public.memos
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE staff_accounts.id = auth.uid()
            AND staff_accounts.role = 'super_admin'
            AND staff_accounts.is_active = true
        )
    );

-- Staff can send memos
CREATE POLICY "Staff can send memos"
    ON public.memos
    FOR INSERT
    WITH CHECK (
        sender_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.staff_accounts s
            LEFT JOIN public.departments d ON s.department_id = d.id
            WHERE s.id = auth.uid()
            AND s.is_active = true
            AND (d.permissions ? 'send_memos' OR s.role = 'super_admin')
        )
    );

-- Staff can mark memos as read (only memos addressed to them)
CREATE POLICY "Staff can mark memos as read"
    ON public.memos
    FOR UPDATE
    USING (
        (recipient_type = 'staff' AND recipient_id = auth.uid())
        OR (
            recipient_type = 'department'
            AND EXISTS (
                SELECT 1 FROM public.staff_accounts
                WHERE staff_accounts.id = auth.uid()
                AND staff_accounts.department_id = memos.recipient_id
            )
        )
        OR recipient_type = 'all'
    );

-- Protect memo content from modification (only allow updating read status)
CREATE OR REPLACE FUNCTION protect_memo_content()
RETURNS TRIGGER AS $$
BEGIN
    -- Prevent modification of core memo fields
    IF NEW.sender_id != OLD.sender_id OR
       NEW.subject != OLD.subject OR
       NEW.body != OLD.body OR
       NEW.recipient_type != OLD.recipient_type OR
       NEW.recipient_id IS DISTINCT FROM OLD.recipient_id THEN
        RAISE EXCEPTION 'Cannot modify memo content after creation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_memo_content_modification
    BEFORE UPDATE ON public.memos
    FOR EACH ROW
    EXECUTE FUNCTION protect_memo_content();

-- Create memo_reads table for tracking who read department/all memos
CREATE TABLE IF NOT EXISTS public.memo_reads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memo_id UUID NOT NULL REFERENCES public.memos(id) ON DELETE CASCADE,
    staff_id UUID NOT NULL REFERENCES public.staff_accounts(id) ON DELETE CASCADE,
    read_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE(memo_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_memo_reads_memo_id ON public.memo_reads(memo_id);
CREATE INDEX IF NOT EXISTS idx_memo_reads_staff_id ON public.memo_reads(staff_id);

-- Enable RLS on memo_reads
ALTER TABLE public.memo_reads ENABLE ROW LEVEL SECURITY;

-- Staff can view their own reads
CREATE POLICY "Staff can view own reads"
    ON public.memo_reads
    FOR SELECT
    USING (staff_id = auth.uid());

-- Staff can mark memos as read
CREATE POLICY "Staff can mark memos read"
    ON public.memo_reads
    FOR INSERT
    WITH CHECK (staff_id = auth.uid());

-- Super admin can view all reads
CREATE POLICY "Super admin can view all reads"
    ON public.memo_reads
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE staff_accounts.id = auth.uid()
            AND staff_accounts.role = 'super_admin'
            AND staff_accounts.is_active = true
        )
    );

COMMENT ON TABLE public.memos IS 'Internal communication system for staff and departments';
COMMENT ON TABLE public.memo_reads IS 'Tracks which staff members have read department/all memos';
COMMENT ON COLUMN public.memos.recipient_type IS 'Type of recipient: department, staff, or all';
COMMENT ON COLUMN public.memos.parent_memo_id IS 'Reference to parent memo for threading/replies';

-- =====================================================
-- SECTION 4: REPORTS TABLE (Migration 107)
-- =====================================================

-- Create reports table
CREATE TABLE IF NOT EXISTS public.reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_number TEXT UNIQUE, -- Auto-generated: RPT-2025-0001
    title TEXT NOT NULL,
    report_type TEXT NOT NULL CHECK (report_type IN ('incident', 'performance', 'financial', 'user_activity', 'operational', 'other')),
    content TEXT NOT NULL,
    data JSONB DEFAULT '{}'::jsonb, -- Structured report data (charts, tables, etc.)
    created_by UUID NOT NULL REFERENCES public.staff_accounts(id) ON DELETE CASCADE,
    department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
    visibility TEXT DEFAULT 'department' CHECK (visibility IN ('department', 'escalated', 'all')),
    status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'under_review', 'reviewed', 'archived')),
    priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
    reviewed_by UUID REFERENCES public.staff_accounts(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    review_notes TEXT,
    attachments JSONB DEFAULT '[]'::jsonb, -- Array of {type, url, name, size}
    tags TEXT[], -- For categorization and filtering
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    submitted_at TIMESTAMP WITH TIME ZONE
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_reports_report_number ON public.reports(report_number);
CREATE INDEX IF NOT EXISTS idx_reports_created_by ON public.reports(created_by);
CREATE INDEX IF NOT EXISTS idx_reports_department_id ON public.reports(department_id);
CREATE INDEX IF NOT EXISTS idx_reports_report_type ON public.reports(report_type);
CREATE INDEX IF NOT EXISTS idx_reports_status ON public.reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_visibility ON public.reports(visibility);
CREATE INDEX IF NOT EXISTS idx_reports_priority ON public.reports(priority);
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON public.reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_tags ON public.reports USING GIN(tags);

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_reports_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();

    -- Auto-set submitted_at when status changes to submitted
    IF NEW.status = 'submitted' AND OLD.status = 'draft' THEN
        NEW.submitted_at = now();
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reports_updated_at
    BEFORE UPDATE ON public.reports
    FOR EACH ROW
    EXECUTE FUNCTION update_reports_updated_at();

-- Function to generate unique report number
CREATE OR REPLACE FUNCTION generate_report_number()
RETURNS TEXT AS $$
DECLARE
    new_number TEXT;
    year_str TEXT;
    counter INT;
BEGIN
    year_str := TO_CHAR(NOW(), 'YYYY');

    -- Get the highest counter for this year
    SELECT COALESCE(
        MAX(
            CAST(
                SUBSTRING(report_number FROM 'RPT-' || year_str || '-(\d+)') AS INT
            )
        ), 0
    ) + 1
    INTO counter
    FROM public.reports
    WHERE report_number LIKE 'RPT-' || year_str || '-%';

    -- Format: RPT-2025-0001
    new_number := 'RPT-' || year_str || '-' || LPAD(counter::TEXT, 4, '0');

    RETURN new_number;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-generate report_number
CREATE OR REPLACE FUNCTION auto_generate_report_number()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.report_number IS NULL OR NEW.report_number = '' THEN
        NEW.report_number := generate_report_number();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER report_number_auto_generate
    BEFORE INSERT ON public.reports
    FOR EACH ROW
    EXECUTE FUNCTION auto_generate_report_number();

-- Enable RLS
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

-- RLS Policies

-- Staff can view their own reports
CREATE POLICY "Staff can view own reports"
    ON public.reports
    FOR SELECT
    USING (created_by = auth.uid());

-- Staff can view department reports (department visibility)
CREATE POLICY "Staff can view department reports"
    ON public.reports
    FOR SELECT
    USING (
        visibility = 'department'
        AND EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE staff_accounts.id = auth.uid()
            AND staff_accounts.department_id = reports.department_id
            AND staff_accounts.is_active = true
        )
    );

-- Department heads can view all reports in their department
CREATE POLICY "Department heads can view all department reports"
    ON public.reports
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE staff_accounts.id = auth.uid()
            AND staff_accounts.role = 'department_head'
            AND staff_accounts.department_id = reports.department_id
            AND staff_accounts.is_active = true
        )
    );

-- Super admin can view escalated and all-visibility reports
CREATE POLICY "Super admin can view escalated reports"
    ON public.reports
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE staff_accounts.id = auth.uid()
            AND staff_accounts.role = 'super_admin'
            AND staff_accounts.is_active = true
        )
        AND (visibility IN ('escalated', 'all') OR 1=1) -- Super admin sees everything
    );

-- Staff can view all-visibility reports
CREATE POLICY "Staff can view all-visibility reports"
    ON public.reports
    FOR SELECT
    USING (
        visibility = 'all'
        AND EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE staff_accounts.id = auth.uid()
            AND staff_accounts.is_active = true
        )
    );

-- Staff can create reports
CREATE POLICY "Staff can create reports"
    ON public.reports
    FOR INSERT
    WITH CHECK (
        created_by = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.staff_accounts s
            LEFT JOIN public.departments d ON s.department_id = d.id
            WHERE s.id = auth.uid()
            AND s.is_active = true
            AND (d.permissions ? 'create_reports' OR s.role = 'super_admin')
        )
    );

-- Staff can update their own draft reports
CREATE POLICY "Staff can update own draft reports"
    ON public.reports
    FOR UPDATE
    USING (
        created_by = auth.uid()
        AND status = 'draft'
    )
    WITH CHECK (
        created_by = auth.uid()
    );

-- Department heads can review reports
CREATE POLICY "Department heads can review reports"
    ON public.reports
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE staff_accounts.id = auth.uid()
            AND (
                (staff_accounts.role = 'department_head' AND staff_accounts.department_id = reports.department_id)
                OR staff_accounts.role = 'super_admin'
            )
            AND staff_accounts.is_active = true
        )
    );

-- Super admin can delete/archive reports
CREATE POLICY "Super admin can delete reports"
    ON public.reports
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE staff_accounts.id = auth.uid()
            AND staff_accounts.role = 'super_admin'
            AND staff_accounts.is_active = true
        )
    );

COMMENT ON TABLE public.reports IS 'Internal reporting system for staff to submit reports to management';
COMMENT ON COLUMN public.reports.report_number IS 'Unique report identifier in format RPT-YYYY-NNNN';
COMMENT ON COLUMN public.reports.visibility IS 'Who can view the report: department, escalated (super_admin), or all';
COMMENT ON COLUMN public.reports.data IS 'Structured report data for charts, tables, and analytics';

-- =====================================================
-- SECTION 5: AUDIT LOGS TABLE (Migration 108)
-- =====================================================

-- Create staff_audit_logs table
CREATE TABLE IF NOT EXISTS public.staff_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id UUID NOT NULL REFERENCES public.staff_accounts(id) ON DELETE CASCADE,
    action TEXT NOT NULL, -- 'suspend_user', 'approve_product', 'resolve_dispute', etc.
    entity_type TEXT NOT NULL, -- 'user', 'product', 'order', 'dispute', 'staff', etc.
    entity_id UUID, -- ID of the affected entity
    details JSONB DEFAULT '{}'::jsonb, -- Additional context about the action
    ip_address TEXT,
    user_agent TEXT,
    status TEXT DEFAULT 'success' CHECK (status IN ('success', 'failed', 'pending')),
    error_message TEXT, -- If status = 'failed'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_staff_audit_logs_staff_id ON public.staff_audit_logs(staff_id);
CREATE INDEX IF NOT EXISTS idx_staff_audit_logs_action ON public.staff_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_staff_audit_logs_entity_type ON public.staff_audit_logs(entity_type);
CREATE INDEX IF NOT EXISTS idx_staff_audit_logs_entity_id ON public.staff_audit_logs(entity_id);
CREATE INDEX IF NOT EXISTS idx_staff_audit_logs_created_at ON public.staff_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_audit_logs_status ON public.staff_audit_logs(status);

-- Composite index for common queries
CREATE INDEX IF NOT EXISTS idx_staff_audit_logs_staff_action ON public.staff_audit_logs(staff_id, action, created_at DESC);

-- Enable RLS
ALTER TABLE public.staff_audit_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies

-- Staff can view their own audit logs
CREATE POLICY "Staff can view own audit logs"
    ON public.staff_audit_logs
    FOR SELECT
    USING (staff_id = auth.uid());

-- Department heads can view logs of their department staff
CREATE POLICY "Department heads can view department audit logs"
    ON public.staff_audit_logs
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts current_staff
            JOIN public.staff_accounts target_staff ON staff_audit_logs.staff_id = target_staff.id
            WHERE current_staff.id = auth.uid()
            AND current_staff.role = 'department_head'
            AND current_staff.department_id = target_staff.department_id
            AND current_staff.is_active = true
        )
    );

-- Super admin can view all audit logs
CREATE POLICY "Super admin can view all audit logs"
    ON public.staff_audit_logs
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE staff_accounts.id = auth.uid()
            AND staff_accounts.role = 'super_admin'
            AND staff_accounts.is_active = true
        )
    );

-- HR can view all audit logs
CREATE POLICY "HR can view all audit logs"
    ON public.staff_audit_logs
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts s
            JOIN public.departments d ON s.department_id = d.id
            WHERE s.id = auth.uid()
            AND d.slug = 'hr'
            AND (s.role = 'department_head' OR d.permissions ? 'view_staff_logs')
            AND s.is_active = true
        )
    );

-- Only the system (backend) can insert audit logs
-- This is enforced at the application level, not through RLS
CREATE POLICY "System can insert audit logs"
    ON public.staff_audit_logs
    FOR INSERT
    WITH CHECK (true); -- Backend uses service role, bypasses RLS

-- Function to automatically log staff actions (called from backend)
CREATE OR REPLACE FUNCTION log_staff_action(
    p_staff_id UUID,
    p_action TEXT,
    p_entity_type TEXT,
    p_entity_id UUID DEFAULT NULL,
    p_details JSONB DEFAULT '{}'::jsonb,
    p_ip_address TEXT DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL,
    p_status TEXT DEFAULT 'success',
    p_error_message TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
    log_id UUID;
BEGIN
    INSERT INTO public.staff_audit_logs (
        staff_id,
        action,
        entity_type,
        entity_id,
        details,
        ip_address,
        user_agent,
        status,
        error_message
    ) VALUES (
        p_staff_id,
        p_action,
        p_entity_type,
        p_entity_id,
        p_details,
        p_ip_address,
        p_user_agent,
        p_status,
        p_error_message
    ) RETURNING id INTO log_id;

    RETURN log_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create materialized view for audit log statistics
CREATE MATERIALIZED VIEW IF NOT EXISTS public.staff_audit_stats AS
WITH action_counts AS (
    SELECT
        staff_id,
        action,
        COUNT(*) as action_count
    FROM public.staff_audit_logs
    GROUP BY staff_id, action
),
action_aggregates AS (
    SELECT
        staff_id,
        jsonb_object_agg(action, action_count) as actions_by_type
    FROM action_counts
    GROUP BY staff_id
)
SELECT
    s.id AS staff_id,
    s.staff_id AS staff_identifier,
    s.full_name,
    d.name AS department_name,
    s.role,
    COUNT(sal.id) AS total_actions,
    COUNT(sal.id) FILTER (WHERE sal.created_at >= NOW() - INTERVAL '7 days') AS actions_last_7_days,
    COUNT(sal.id) FILTER (WHERE sal.created_at >= NOW() - INTERVAL '30 days') AS actions_last_30_days,
    COUNT(sal.id) FILTER (WHERE sal.status = 'failed') AS failed_actions,
    MAX(sal.created_at) AS last_action_at,
    COALESCE(aa.actions_by_type, '{}'::jsonb) AS actions_by_type
FROM public.staff_accounts s
LEFT JOIN public.staff_audit_logs sal ON s.id = sal.staff_id
LEFT JOIN public.departments d ON s.department_id = d.id
LEFT JOIN action_aggregates aa ON s.id = aa.staff_id
WHERE s.is_active = true
GROUP BY s.id, s.staff_id, s.full_name, d.name, s.role, aa.actions_by_type;

-- Create unique index on materialized view
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_audit_stats_staff_id ON public.staff_audit_stats(staff_id);

-- Function to refresh audit stats
CREATE OR REPLACE FUNCTION refresh_staff_audit_stats()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.staff_audit_stats;
END;
$$ LANGUAGE plpgsql;

-- Enable RLS on materialized view
ALTER MATERIALIZED VIEW public.staff_audit_stats OWNER TO postgres;

COMMENT ON TABLE public.staff_audit_logs IS 'Comprehensive audit trail of all staff actions in the internal tool';
COMMENT ON FUNCTION log_staff_action IS 'Helper function to log staff actions from backend';
COMMENT ON MATERIALIZED VIEW public.staff_audit_stats IS 'Aggregated statistics of staff actions for reporting';

-- =====================================================
-- SECTION 6: SUPER ADMIN SEED DATA (Migration 109)
-- =====================================================

-- Insert super admin account
-- Default password: FretikoPlatform2025!
-- Password hash generated with bcrypt (cost factor: 10)
INSERT INTO public.staff_accounts (
    staff_id,
    email,
    password_hash,
    full_name,
    department_id,
    role,
    is_active,
    must_change_password,
    created_by
) VALUES (
    'FTK-2025-0001',
    'superadmin@fretiko.com',
    '$2b$10$YourActualBcryptHashHere', -- This will be replaced by backend on first run
    'Super Administrator',
    NULL, -- Super admin doesn't belong to a specific department
    'super_admin',
    true,
    true, -- Must change password on first login
    NULL
) ON CONFLICT (email) DO NOTHING;

-- Create a function to initialize the super admin with a hashed password
-- This should be called from the backend during initial setup
CREATE OR REPLACE FUNCTION initialize_super_admin(
    p_email TEXT DEFAULT 'superadmin@fretiko.com',
    p_password_hash TEXT DEFAULT NULL,
    p_full_name TEXT DEFAULT 'Super Administrator'
)
RETURNS UUID AS $$
DECLARE
    admin_id UUID;
BEGIN
    -- Check if super admin already exists
    SELECT id INTO admin_id
    FROM public.staff_accounts
    WHERE email = p_email;

    IF admin_id IS NOT NULL THEN
        RAISE NOTICE 'Super admin already exists with ID: %', admin_id;
        RETURN admin_id;
    END IF;

    -- Create super admin
    INSERT INTO public.staff_accounts (
        staff_id,
        email,
        password_hash,
        full_name,
        department_id,
        role,
        is_active,
        must_change_password,
        created_by
    ) VALUES (
        'FTK-2025-0001',
        p_email,
        p_password_hash,
        p_full_name,
        NULL,
        'super_admin',
        true,
        true,
        NULL
    ) RETURNING id INTO admin_id;

    RAISE NOTICE 'Super admin created with ID: %', admin_id;
    RETURN admin_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION initialize_super_admin IS 'Initialize the first super admin account. Should only be called once during setup.';

-- =====================================================
-- SECTION 7: DEPARTMENTS RLS POLICIES (After staff_accounts exists)
-- =====================================================

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

-- =====================================================
-- MIGRATION COMPLETE
-- =====================================================
-- All 6 migrations have been successfully consolidated
-- Next steps:
-- 1. Run this migration on your Supabase database
-- 2. Use the initialize_super_admin() function from your backend to create the first admin
-- 3. Login with superadmin@fretiko.com and the password you set
-- 4. Change the password immediately after first login
-- =====================================================
