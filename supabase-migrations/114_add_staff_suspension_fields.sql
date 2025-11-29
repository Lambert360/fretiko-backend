-- =====================================================
-- ADD STAFF SUSPENSION FIELDS
-- =====================================================
-- This migration adds fields to track staff suspensions separately from deactivation

ALTER TABLE public.staff_accounts
ADD COLUMN IF NOT EXISTS is_suspended BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS suspended_by UUID REFERENCES public.staff_accounts(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS suspension_reason TEXT,
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

-- Create index for suspended staff
CREATE INDEX IF NOT EXISTS idx_staff_accounts_is_suspended ON public.staff_accounts(is_suspended);

-- Create index for deleted staff
CREATE INDEX IF NOT EXISTS idx_staff_accounts_deleted_at ON public.staff_accounts(deleted_at);

COMMENT ON COLUMN public.staff_accounts.is_suspended IS 'Whether the staff account is temporarily suspended';
COMMENT ON COLUMN public.staff_accounts.suspended_at IS 'Timestamp when the staff account was suspended';
COMMENT ON COLUMN public.staff_accounts.suspended_by IS 'ID of the staff member who suspended this account';
COMMENT ON COLUMN public.staff_accounts.suspension_reason IS 'Reason for the suspension';
COMMENT ON COLUMN public.staff_accounts.deleted_at IS 'Timestamp when the staff account was deleted (soft delete for audit purposes)';

