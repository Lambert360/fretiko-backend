-- =====================================================
-- PART 2A: EMAIL VERIFICATION - INDIVIDUAL FUNCTIONS
-- =====================================================
-- Migration: Add email verification functions (no dependencies)
-- Description: Creates functions that don't reference each other
-- Date: 2026-03-01
-- Prerequisites: Must run 160a_email_verification_tables.sql first

-- =====================================================
-- CREATE EMAIL VERIFICATION FUNCTIONS (INDEPENDENT)
-- =====================================================

-- Function to generate email verification token
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if email verification token is valid
CREATE OR REPLACE FUNCTION public.is_email_verification_token_valid(
    p_token TEXT,
    p_user_id UUID
)
RETURNS BOOLEAN AS $$
DECLARE
    token_exists BOOLEAN;
    token_expired BOOLEAN;
BEGIN
    -- Check if token exists and belongs to user
    SELECT EXISTS(
        SELECT 1 FROM public.user_profiles
        WHERE email_confirmation_token = p_token
        AND id = p_user_id
    ) INTO token_exists;

    -- Check if token is expired
    SELECT EXISTS(
        SELECT 1 FROM public.user_profiles
        WHERE email_confirmation_token = p_token
        AND id = p_user_id
        AND email_confirmation_expires_at < NOW()
    ) INTO token_expired;

    RETURN token_exists AND NOT token_expired;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- COMMENTS FOR FUNCTIONS
-- =====================================================

COMMENT ON FUNCTION public.generate_email_verification_token() IS 'Generates a secure random token for email verification';
COMMENT ON FUNCTION public.is_email_verification_token_valid() IS 'Validates if email verification token is valid and not expired';

-- =====================================================
-- COMPLETION
-- =====================================================

-- This part adds:
-- ✅ Email verification token generation function
-- ✅ Token validation function

COMMIT;
