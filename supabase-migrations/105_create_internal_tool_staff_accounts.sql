-- =====================================================
-- FRETIKO INTERNAL TOOL: STAFF ACCOUNTS TABLE
-- =====================================================
-- This migration creates the staff accounts table for internal tool users

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
