-- =====================================================
-- ADD PASSWORD RESET COLUMNS TO STAFF_ACCOUNTS
-- =====================================================
-- This migration adds password reset columns to staff_accounts table
-- to enable admin password reset functionality

-- Add reset token columns to staff_accounts table
ALTER TABLE public.staff_accounts
ADD COLUMN IF NOT EXISTS reset_token TEXT,
ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMP WITH TIME ZONE;

-- Create index for reset token lookup
CREATE INDEX IF NOT EXISTS idx_staff_accounts_reset_token ON public.staff_accounts(reset_token);
CREATE INDEX IF NOT EXISTS idx_staff_accounts_reset_token_expires_at ON public.staff_accounts(reset_token_expires_at);

-- Comments
COMMENT ON COLUMN public.staff_accounts.reset_token IS 'Password reset token for admin accounts';
COMMENT ON COLUMN public.staff_accounts.reset_token_expires_at IS 'Expiration time for password reset token';
