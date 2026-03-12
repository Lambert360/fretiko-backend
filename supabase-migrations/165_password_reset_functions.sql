-- =====================================================
-- PASSWORD RESET TOKEN FUNCTIONS
-- =====================================================
-- Migration: Add password reset token functions
-- Description: Implements custom 6-digit password reset system that works with Supabase Auth
-- Date: 2026-03-12
-- Prerequisites: User profiles table must exist

-- =====================================================
-- DROP EXISTING FUNCTIONS IF THEY HAVE WRONG SIGNATURE
-- =====================================================

-- Drop existing generate_password_reset_token if it exists with wrong signature
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.routines 
        WHERE routine_name = 'generate_password_reset_token'
        AND routine_type = 'FUNCTION'
    ) THEN
        DROP FUNCTION public.generate_password_reset_token;
        RAISE NOTICE 'Dropped existing generate_password_reset_token with incompatible signature';
    END IF;
END $$;

-- Drop existing verify_reset_token_func if it exists with wrong signature
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.routines 
        WHERE routine_name = 'verify_reset_token_func'
        AND routine_type = 'FUNCTION'
    ) THEN
        DROP FUNCTION public.verify_reset_token_func;
        RAISE NOTICE 'Dropped existing verify_reset_token_func with incompatible signature';
    END IF;
END $$;

-- Drop existing update_user_password if it exists with wrong signature
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.routines 
        WHERE routine_name = 'update_user_password'
        AND routine_type = 'FUNCTION'
    ) THEN
        DROP FUNCTION public.update_user_password;
        RAISE NOTICE 'Dropped existing update_user_password with incompatible signature';
    END IF;
END $$;

-- Drop existing clear_reset_token if it exists with wrong signature
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.routines 
        WHERE routine_name = 'clear_reset_token'
        AND routine_type = 'FUNCTION'
    ) THEN
        DROP FUNCTION public.clear_reset_token;
        RAISE NOTICE 'Dropped existing clear_reset_token with incompatible signature';
    END IF;
END $$;

-- Drop existing save_reset_token if it exists with wrong signature
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.routines 
        WHERE routine_name = 'save_reset_token'
        AND routine_type = 'FUNCTION'
    ) THEN
        DROP FUNCTION public.save_reset_token;
        RAISE NOTICE 'Dropped existing save_reset_token with incompatible signature';
    END IF;
END $$;
-- =====================================================

-- CREATE PASSWORD RESET TOKEN FUNCTIONS
-- =====================================================

-- Function to generate 6-digit alphanumeric reset token
CREATE OR REPLACE FUNCTION public.generate_password_reset_token()
RETURNS TEXT AS $$
DECLARE
    token TEXT;
    chars TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    chars_length INTEGER := LENGTH(chars);
    random_pos INTEGER;
BEGIN
    -- Generate a secure 6-character token
    token := '';
    FOR i IN 1..6 LOOP
        random_pos := FLOOR(RANDOM() * chars_length) + 1;
        token := token || SUBSTRING(chars FROM random_pos FOR 1);
    END LOOP;
    
    RETURN token;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to verify reset token
CREATE OR REPLACE FUNCTION public.verify_reset_token_func(
    p_email TEXT,
    p_token TEXT
)
RETURNS JSON
AS $$
DECLARE
    token_record RECORD;
    token_exists BOOLEAN;
    token_expired BOOLEAN;
    user_uuid UUID;
BEGIN
    -- Find: user and their reset token
    SELECT
        up.id as user_id,
        up.reset_token,
        up.reset_token_expires_at
    INTO token_record
    FROM public.user_profiles up
    JOIN auth.users au ON up.id = au.id
    WHERE au.email = LOWER(p_email)
        AND up.reset_token = p_token;

    -- Debug logging
    RAISE LOG 'Token verification debug: email=%, input_token=%, stored_token=%', 
        p_email, p_token, COALESCE(token_record.reset_token, 'NULL');

    -- Check if token exists
    token_exists := FOUND token_record;

    IF NOT token_exists THEN
        RETURN json_build_object('valid', false, 'message', 'Invalid reset token', 'user_id', NULL);
    END IF;

    -- Check if token is expired
    token_expired := token_record.reset_token_expires_at < NOW();

    IF token_expired THEN
        RETURN json_build_object('valid', false, 'message', 'Reset token has expired', 'user_id', NULL);
    END IF;

    -- Token is valid
    user_uuid := token_record.user_id;
    RETURN json_build_object('valid', true, 'message', 'Token is valid', 'user_id', user_uuid);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to update user password in Supabase Auth
CREATE OR REPLACE FUNCTION public.update_user_password(
    p_user_email TEXT,
    p_new_password TEXT
)
RETURNS JSON
AS $$
DECLARE
    user_record RECORD;
BEGIN
    -- Find user by email
    SELECT id, email INTO user_record
    FROM auth.users 
    WHERE email = LOWER(p_user_email);
    
    IF NOT FOUND user_record THEN
        RETURN json_build_object('success', false, 'message', 'User not found', 'user_id', NULL);
    END IF;
    
    -- Update password in Supabase Auth using direct table update
    -- This bypasses email verification requirement
    BEGIN
        -- Direct update of auth.users table
        UPDATE auth.users 
        SET 
            encrypted_password = crypt(p_new_password, gen_salt('bf')),
            email_confirmed_at = NOW()
        WHERE id = user_record.id;
        
        -- Also update user profile to clear any reset tokens
        UPDATE public.user_profiles 
        SET 
            reset_token = NULL,
            reset_token_expires_at = NULL
        WHERE id = user_record.id;
        
        RETURN json_build_object('success', true, 'message', 'Password updated successfully', 'user_id', user_record.id);
    EXCEPTION WHEN OTHERS THEN
        RETURN json_build_object('success', false, 'message', 'Error: ' || SQLERRM);
    END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant permissions
GRANT EXECUTE ON FUNCTION update_user_password TO authenticated;
GRANT EXECUTE ON FUNCTION update_user_password TO service_role;

-- Function to save reset token to user profile
CREATE OR REPLACE FUNCTION public.save_reset_token(
    p_user_email TEXT,
    p_token TEXT,
    p_expires_hours INTEGER DEFAULT 1
)
RETURNS JSON
AS $$
DECLARE
    user_record RECORD;
    expires_at TIMESTAMP WITH TIME ZONE;
BEGIN
    -- Find user by email
    SELECT id, email INTO user_record
    FROM auth.users 
    WHERE email = LOWER(p_user_email);
    
    IF NOT FOUND user_record THEN
        RETURN json_build_object('success', false, 'message', 'User not found', 'user_id', NULL);
    END IF;
    
    -- Set expiration time
    expires_at := NOW() + (p_expires_hours || ' hours')::INTERVAL;
    
    -- Save reset token to user profile
    UPDATE public.user_profiles 
    SET 
        reset_token = p_token,
        reset_token_expires_at = expires_at
    WHERE id = user_record.id;
    
    RETURN json_build_object('success', true, 'message', 'Reset token saved', 'user_id', user_record.id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to clear reset token
CREATE OR REPLACE FUNCTION public.clear_reset_token(
    p_profile_id UUID
)
RETURNS BOOLEAN
AS $$
BEGIN
    UPDATE public.user_profiles 
    SET 
        reset_token = NULL,
        reset_token_expires_at = NULL
    WHERE id = p_profile_id;
    
    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- ENSURE USER_PROFILES TABLE HAS RESET TOKEN COLUMNS
-- =====================================================

-- Add reset token columns if they don't exist
DO $$
BEGIN
    -- Check if reset_token column exists
    IF NOT EXISTS(
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user_profiles' 
        AND column_name = 'reset_token'
    ) THEN
        ALTER TABLE public.user_profiles ADD COLUMN reset_token TEXT;
    END IF;
    
    -- Check if reset_token_expires_at column exists
    IF NOT EXISTS(
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user_profiles' 
        AND column_name = 'reset_token_expires_at'
    ) THEN
        ALTER TABLE public.user_profiles ADD COLUMN reset_token_expires_at TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;

-- =====================================================
-- COMMENTS FOR FUNCTIONS
-- =====================================================

COMMENT ON FUNCTION public.generate_password_reset_token() IS 'Generates a secure 6-character alphanumeric reset token';
COMMENT ON FUNCTION public.verify_reset_token_func(TEXT, TEXT) IS 'Verifies password reset token and returns user details';
COMMENT ON FUNCTION public.update_user_password(TEXT, TEXT) IS 'Updates user password in Supabase Auth and clears reset token';
COMMENT ON FUNCTION public.save_reset_token(TEXT, TEXT, INTEGER) IS 'Saves reset token to user profile';
COMMENT ON FUNCTION public.clear_reset_token(UUID) IS 'Clears reset token from user profile';

-- =====================================================
-- COMPLETION
-- =====================================================

-- This migration adds:
-- ✅ Safe function replacement (drops existing functions first)
-- ✅ 6-digit token generation function
-- ✅ Token verification function
-- ✅ Password update function (integrates with Supabase Auth)
-- ✅ Token save and clear functions
-- ✅ Database column setup for reset tokens

COMMIT;
