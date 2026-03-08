-- =====================================================
-- ADD EMAIL VERIFICATION SYSTEM
-- =====================================================
-- MIGRATION: 160_add_email_verification_system.sql
-- =====================================================
-- Description: Adds complete email verification system
-- Prerequisites: None (idempotent with IF NOT EXISTS)
-- Date: 2026-03-01

-- =====================================================
-- ENABLE REQUIRED EXTENSIONS
-- =====================================================

-- Ensure pgcrypto extension is available for secure token generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================
-- UPDATE USER_PROFILES TABLE (TERMS ACCEPTANCE)
-- =====================================================

-- Add terms acceptance tracking to user_profiles
ALTER TABLE public.user_profiles
ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS terms_accepted_ip VARCHAR(45),
ADD COLUMN IF NOT EXISTS terms_accepted_user_agent TEXT;

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

-- Create policy only if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'email_verification_logs'
        AND policyname = 'Users can view own verification logs'
    ) THEN
        CREATE POLICY "Users can view own verification logs" ON public.email_verification_logs
        FOR SELECT USING (auth.uid() = user_id);
    END IF;
END $$;

-- Staff can view all verification logs (handled via service role in backend)
-- No INSERT/UPDATE/DELETE policies for users - only staff via backend

-- =====================================================
-- CREATE EMAIL VERIFICATION FUNCTIONS
-- =====================================================

-- Function 1: generate_email_verification_token (no dependencies)
CREATE OR REPLACE FUNCTION public.generate_email_verification_token()
RETURNS TEXT AS $$
DECLARE
    token TEXT;
BEGIN
    -- Generate a secure random token (32 characters)
    token := encode(
        gen_random_bytes(16),
        'hex'
    );
    RETURN token;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Function 2: verify_user_email (no external dependencies)
CREATE OR REPLACE FUNCTION public.verify_user_email(
    p_token TEXT,
    p_user_id UUID
)
RETURNS BOOLEAN AS $$
DECLARE
    is_valid BOOLEAN;
BEGIN
    -- Inline validation logic to avoid function dependency issues
    SELECT EXISTS(
        SELECT 1 FROM public.user_profiles
        WHERE email_confirmation_token = p_token
        AND id = p_user_id
        AND email_confirmation_expires_at > NOW()
    ) INTO is_valid;

    IF is_valid THEN
        -- Mark email as confirmed
        UPDATE public.user_profiles
        SET
            email_confirmed = TRUE,
            email_confirmation_token = NULL,
            email_confirmation_expires_at = NULL,
            terms_accepted_at = NOW(),
            terms_accepted_ip = inet_client_addr(),
            terms_accepted_user_agent = COALESCE(
                current_setting('request.headers', true)::json->>'user-agent',
                NULL
            )
        WHERE id = p_user_id
        AND email_confirmation_token = p_token;  -- Extra safety against race conditions

        -- Log successful verification
        INSERT INTO public.email_verification_logs (
            user_id,
            email,
            action,
            ip_address
        )
        SELECT
            p_user_id,
            au.email,
            'verified',
            inet_client_addr()
        FROM auth.users au
        WHERE au.id = p_user_id;

        RETURN TRUE;
    ELSE
        -- Log failed verification attempt
        INSERT INTO public.email_verification_logs (
            user_id,
            email,
            action,
            error_message
        )
        SELECT
            p_user_id,
            au.email,
            'failed',
            'Invalid or expired verification token'
        FROM auth.users au
        WHERE au.id = p_user_id;

        RETURN FALSE;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Function 3: handle_new_user (depends on function 1)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    verification_token TEXT;
    verification_expires TIMESTAMP WITH TIME ZONE;
BEGIN
    -- Generate verification token
    verification_token := public.generate_email_verification_token();

    -- Set expiration to 24 hours from now
    verification_expires := NOW() + INTERVAL '24 hours';

    -- Insert user profile with email verification setup
    INSERT INTO public.user_profiles (id, username, user_role, gender, email_confirmation_token, email_confirmation_expires_at)
    VALUES (
        NEW.id,
        COALESCE(
            NEW.raw_user_meta_data->>'username',
            LOWER(SPLIT_PART(NEW.email, '@', 1))
        ),
        COALESCE(NEW.raw_user_meta_data->>'user_role', 'citizen'),
        NEW.raw_user_meta_data->>'gender',
        verification_token,
        verification_expires
    );

    -- Log verification email sent
    INSERT INTO public.email_verification_logs (
        user_id,
        email,
        action
    )
    VALUES (
        NEW.id,
        NEW.email,
        'sent'
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- =====================================================
-- CREATE TRIGGER
-- =====================================================

-- Ensure the auth user trigger exists
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =====================================================
-- CREATE UNIQUE INDEX FOR EMAIL VERIFICATION TOKENS
-- =====================================================

-- Add unique index for email verification tokens (prevents duplicates, improves lookup)
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_profiles_email_token
ON public.user_profiles(email_confirmation_token)
WHERE email_confirmation_token IS NOT NULL;

-- =====================================================
-- COMMENTS
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

COMMENT ON FUNCTION public.generate_email_verification_token() IS 'Generates a secure random token for email verification';
COMMENT ON FUNCTION public.verify_user_email() IS 'Verifies user email and marks account as confirmed';

-- =====================================================
-- COMPLETION
-- =====================================================

-- This migration adds:
-- ✅ Email verification system with secure tokens
-- ✅ Terms acceptance tracking for legal compliance
-- ✅ Verification logs for audit trail
-- ✅ Proper RLS policies following app security model
-- ✅ Functions for token validation and email confirmation
-- ✅ Automatic verification token generation on signup
