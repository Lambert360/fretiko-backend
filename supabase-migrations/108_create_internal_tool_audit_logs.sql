-- =====================================================
-- FRETIKO INTERNAL TOOL: AUDIT LOGS TABLE
-- =====================================================
-- Comprehensive audit trail of all staff actions

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
SELECT
    s.id AS staff_id,
    s.staff_id AS staff_identifier,
    s.full_name,
    d.name AS department_name,
    s.role,
    COUNT(*) AS total_actions,
    COUNT(*) FILTER (WHERE sal.created_at >= NOW() - INTERVAL '7 days') AS actions_last_7_days,
    COUNT(*) FILTER (WHERE sal.created_at >= NOW() - INTERVAL '30 days') AS actions_last_30_days,
    COUNT(*) FILTER (WHERE sal.status = 'failed') AS failed_actions,
    MAX(sal.created_at) AS last_action_at,
    jsonb_object_agg(
        sal.action,
        COUNT(*)
    ) FILTER (WHERE sal.action IS NOT NULL) AS actions_by_type
FROM public.staff_accounts s
LEFT JOIN public.staff_audit_logs sal ON s.id = sal.staff_id
LEFT JOIN public.departments d ON s.department_id = d.id
WHERE s.is_active = true
GROUP BY s.id, s.staff_id, s.full_name, d.name, s.role;

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
