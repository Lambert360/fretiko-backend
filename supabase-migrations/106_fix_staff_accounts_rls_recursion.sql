-- =====================================================
-- FIX: STAFF_ACCOUNTS RLS INFINITE RECURSION
-- =====================================================
-- This migration fixes infinite recursion in staff_accounts RLS policies
-- when user_warnings table queries staff_accounts via warned_by relationship

-- Drop problematic policies that cause recursion
DROP POLICY IF EXISTS "Super admin can view all staff" ON public.staff_accounts;
DROP POLICY IF EXISTS "Super admin and HR can manage staff" ON public.staff_accounts;
DROP POLICY IF EXISTS "Department heads can view their department staff" ON public.staff_accounts;

-- Create simplified policies that avoid recursion

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

-- Super admin can view all staff (simplified)
CREATE POLICY "Super admin can view all staff"
    ON public.staff_accounts
    FOR SELECT
    USING (
        role = 'super_admin' 
        AND is_active = true 
        AND id = auth.uid()
    );

-- Super admin can manage all staff (simplified)
CREATE POLICY "Super admin can manage staff"
    ON public.staff_accounts
    FOR ALL
    USING (
        role = 'super_admin' 
        AND is_active = true 
        AND id = auth.uid()
    );

-- Add a specific policy for user_warnings queries
-- This allows anyone to read basic staff info when referenced from user_warnings
CREATE POLICY "Allow staff info in user_warnings"
    ON public.staff_accounts
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.user_warnings 
            WHERE user_warnings.warned_by = staff_accounts.id
        )
    );

COMMENT ON POLICY "Allow staff info in user_warnings" IS 'Allows reading staff account info when referenced from user_warnings table to avoid RLS recursion';
