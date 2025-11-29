-- =====================================================
-- FRETIKO INTERNAL TOOL: REPORTS TABLE
-- =====================================================
-- Reporting system for staff to submit reports to management

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
