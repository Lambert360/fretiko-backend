-- =====================================================
-- PART 1: EMAIL VERIFICATION - TABLE STRUCTURE
-- =====================================================
-- Migration: Add email verification fields and terms acceptance
-- Description: Implements email verification system to prevent fake accounts
-- Date: 2026-03-01

-- =====================================================
-- UPDATE USER_PROFILES TABLE (EMAIL VERIFICATION)
-- =====================================================

-- Add email verification fields to user_profiles table
-- Note: This modifies your application's user_profiles table (not auth.users)
ALTER TABLE public.user_profiles 
ADD COLUMN IF NOT EXISTS email_confirmed BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS email_confirmation_token VARCHAR(255),
ADD COLUMN IF NOT EXISTS email_confirmation_expires_at TIMESTAMP WITH TIME ZONE;

-- =====================================================
-- UPDATE USER_PROFILES TABLE (TERMS ACCEPTANCE)
-- =====================================================

-- Add terms acceptance tracking to user_profiles
ALTER TABLE public.user_profiles
ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS terms_accepted_ip VARCHAR(45),
ADD COLUMN IF NOT EXISTS terms_accepted_user_agent TEXT;

-- =====================================================
-- CREATE EMAIL VERIFICATION LOGS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS public.email_verification_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    action VARCHAR(20) NOT NULL CHECK (action IN ('sent', 'verified', 'resent', 'failed')),
    ip_address VARCHAR(45),
    user_agent TEXT,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- CREATE INDEXES
-- =====================================================

-- Indexes for email verification logs
CREATE INDEX IF NOT EXISTS idx_email_verification_logs_user_id ON public.email_verification_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_logs_created_at ON public.email_verification_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_verification_logs_action ON public.email_verification_logs(action);

-- =====================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================

-- Enable RLS for email verification logs
ALTER TABLE public.email_verification_logs ENABLE ROW LEVEL SECURITY;

-- Users can view their own verification logs
CREATE POLICY "Users can view own verification logs" ON public.email_verification_logs
FOR SELECT USING (auth.uid() = user_id);

-- Staff can view all verification logs (handled via service role in backend)
-- No INSERT/UPDATE/DELETE policies for users - only staff via backend

-- =====================================================
-- COMMENTS FOR TABLE STRUCTURE
-- =====================================================

COMMENT ON TABLE public.email_verification_logs IS 'Tracks email verification activities for security and audit purposes';
COMMENT ON COLUMN public.email_verification_logs.action IS 'Type of verification action: sent, verified, resent, failed';
COMMENT ON COLUMN public.email_verification_logs.ip_address IS 'IP address of the user when verification was requested';
COMMENT ON COLUMN public.email_verification_logs.user_agent IS 'User agent string of the client';
COMMENT ON COLUMN public.email_verification_logs.error_message IS 'Error message for failed verification attempts';

COMMENT ON COLUMN public.user_profiles.email_confirmed IS 'Whether the user has verified their email address';
COMMENT ON COLUMN public.user_profiles.email_confirmation_token IS 'Token used for email verification (null when verified)';
COMMENT ON COLUMN public.user_profiles.email_confirmation_expires_at IS 'Expiration time for email verification token';

COMMENT ON COLUMN public.user_profiles.terms_accepted_at IS 'Timestamp when user accepted terms of service';
COMMENT ON COLUMN public.user_profiles.terms_accepted_ip IS 'IP address when user accepted terms';
COMMENT ON COLUMN public.user_profiles.terms_accepted_user_agent IS 'User agent string when user accepted terms';

-- =====================================================
-- COMPLETION
-- =====================================================

-- This part adds:
-- ✅ Email verification columns to user_profiles
-- ✅ Terms acceptance tracking for legal compliance
-- ✅ Verification logs table for audit trail
-- ✅ Proper RLS policies following app security model
-- ✅ Indexes for performance

COMMIT;
