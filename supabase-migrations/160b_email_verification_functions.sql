-- =====================================================
-- PART 2: EMAIL VERIFICATION - FUNCTIONS AND TRIGGERS
-- =====================================================
-- Migration: Add email verification functions and triggers
-- Description: Implements email verification system functions
-- Date: 2026-03-01
-- Prerequisites: Must run 160a_email_verification_tables.sql first

-- =====================================================
-- CREATE EMAIL VERIFICATION FUNCTIONS
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

-- Function to verify email and mark user as confirmed
CREATE OR REPLACE FUNCTION public.verify_user_email(
    p_token TEXT,
    p_user_id UUID
)
RETURNS BOOLEAN AS $$
DECLARE
    is_valid BOOLEAN;
BEGIN
    -- Check if token is valid
    is_valid := public.is_email_verification_token_valid(p_token, p_user_id);
    
    IF is_valid THEN
        -- Mark email as confirmed
        UPDATE public.user_profiles 
        SET 
            email_confirmed = TRUE,
            email_confirmation_token = NULL,
            email_confirmation_expires_at = NULL,
            terms_accepted_at = NOW(),
            terms_accepted_ip = inet_client_addr(),
            terms_accepted_user_agent = current_setting('request.headers')::json->>'user-agent'
        WHERE id = p_user_id;
        
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- CREATE TRIGGER TO HANDLE NEW USER SIGNUP
-- =====================================================

-- Update handle_new_user function to include email verification setup
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- CREATE TRIGGER
-- =====================================================

-- Ensure the auth user trigger exists
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =====================================================
-- COMMENTS FOR FUNCTIONS
-- =====================================================

COMMENT ON FUNCTION public.generate_email_verification_token() IS 'Generates a secure random token for email verification';
COMMENT ON FUNCTION public.is_email_verification_token_valid() IS 'Validates if email verification token is valid and not expired';
COMMENT ON FUNCTION public.verify_user_email() IS 'Verifies user email and marks account as confirmed';

-- =====================================================
-- COMPLETION
-- =====================================================

-- This part adds:
-- ✅ Email verification token generation
-- ✅ Token validation functions
-- ✅ Email confirmation function
-- ✅ Updated user signup trigger with email verification
-- ✅ Automatic verification token generation on signup

COMMIT;
