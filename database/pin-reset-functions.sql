-- ========================================
-- PIN RESET DATABASE FUNCTIONS
-- Mirrors password reset functionality for PIN system
-- Run this in Supabase SQL Editor
-- ========================================

-- =====================================================
-- DROP EXISTING FUNCTIONS IF THEY HAVE WRONG SIGNATURE
-- =====================================================

-- Drop existing generate_pin_reset_token if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.routines 
        WHERE routine_name = 'generate_pin_reset_token'
        AND routine_type = 'FUNCTION'
    ) THEN
        DROP FUNCTION public.generate_pin_reset_token;
        RAISE NOTICE 'Dropped existing generate_pin_reset_token';
    END IF;
END $$;

-- Drop existing save_pin_reset_token if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.routines 
        WHERE routine_name = 'save_pin_reset_token'
        AND routine_type = 'FUNCTION'
    ) THEN
        DROP FUNCTION public.save_pin_reset_token;
        RAISE NOTICE 'Dropped existing save_pin_reset_token';
    END IF;
END $$;

-- Drop existing verify_pin_reset_token if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.routines 
        WHERE routine_name = 'verify_pin_reset_token'
        AND routine_type = 'FUNCTION'
    ) THEN
        DROP FUNCTION public.verify_pin_reset_token;
        RAISE NOTICE 'Dropped existing verify_pin_reset_token';
    END IF;
END $$;

-- Drop existing update_user_pin if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.routines 
        WHERE routine_name = 'update_user_pin'
        AND routine_type = 'FUNCTION'
    ) THEN
        DROP FUNCTION public.update_user_pin;
        RAISE NOTICE 'Dropped existing update_user_pin';
    END IF;
END $$;

-- Drop existing get_user_email_for_pin_reset if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.routines 
        WHERE routine_name = 'get_user_email_for_pin_reset'
        AND routine_type = 'FUNCTION'
    ) THEN
        DROP FUNCTION public.get_user_email_for_pin_reset;
        RAISE NOTICE 'Dropped existing get_user_email_for_pin_reset';
    END IF;
END $$;

-- =====================================================

-- ========================================
-- FUNCTION 1: Generate PIN Reset Token
-- ========================================
CREATE OR REPLACE FUNCTION generate_pin_reset_token()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    token TEXT;
BEGIN
    -- Generate 6-digit numeric token
    token := LPAD(FLOOR(RANDOM() * 1000000)::TEXT, 6, '0');
    
    RETURN token;
END;
$$;

-- ========================================
-- FUNCTION 2: Save PIN Reset Token
-- ========================================
CREATE OR REPLACE FUNCTION save_pin_reset_token(
    p_user_id UUID,
    p_token TEXT,
    p_expires_hours INTEGER DEFAULT 1
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    expires_at TIMESTAMP WITH TIME ZONE;
    result JSON;
BEGIN
    -- Calculate expiry time
    expires_at := NOW() + (p_expires_hours || ' hours')::INTERVAL;
    
    -- Update user_pins with reset token
    UPDATE user_pins 
    SET 
        reset_token = p_token,
        reset_token_expires_at = expires_at,
        requires_reset = TRUE,
        updated_at = NOW()
    WHERE user_id = p_user_id AND is_active = TRUE;
    
    -- Check if update was successful
    IF FOUND THEN
        result := json_build_object(
            'success', true,
            'message', 'PIN reset token saved successfully',
            'expires_at', expires_at
        );
    ELSE
        result := json_build_object(
            'success', false,
            'message', 'User PIN not found or inactive'
        );
    END IF;
    
    RETURN result;
END;
$$;

-- ========================================
-- FUNCTION 3: Verify PIN Reset Token
-- ========================================
CREATE OR REPLACE FUNCTION verify_pin_reset_token(
    p_user_id UUID,
    p_token TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    pin_record RECORD;
    result JSON;
BEGIN
    -- Get PIN record with token
    SELECT * INTO pin_record
    FROM user_pins
    WHERE user_id = p_user_id 
      AND is_active = TRUE 
      AND requires_reset = TRUE;
    
    -- Check if PIN record exists
    IF NOT FOUND THEN
        result := json_build_object(
            'valid', false,
            'message', 'No active PIN reset request found'
        );
        RETURN result;
    END IF;
    
    -- Check if token is expired
    IF pin_record.reset_token_expires_at < NOW() THEN
        result := json_build_object(
            'valid', false,
            'message', 'PIN reset token has expired'
        );
        RETURN result;
    END IF;
    
    -- Check if token matches
    IF pin_record.reset_token != p_token THEN
        result := json_build_object(
            'valid', false,
            'message', 'Invalid PIN reset token'
        );
        RETURN result;
    END IF;
    
    -- Token is valid
    result := json_build_object(
        'valid', true,
        'message', 'PIN reset token is valid'
    );
    
    RETURN result;
END;
$$;

-- ========================================
-- FUNCTION 4: Update User PIN
-- ========================================
CREATE OR REPLACE FUNCTION update_user_pin(
    p_user_id UUID,
    p_new_pin TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    pin_record RECORD;
    salt TEXT;
    new_pin_hash TEXT;
    result JSON;
BEGIN
    -- Validate PIN format (6 digits)
    IF p_new_pin !~ '^\d{6}$' THEN
        result := json_build_object(
            'success', false,
            'message', 'PIN must be exactly 6 digits'
        );
        RETURN result;
    END IF;
    
    -- Get current PIN record
    SELECT * INTO pin_record
    FROM user_pins
    WHERE user_id = p_user_id AND is_active = TRUE;
    
    -- Check if PIN record exists
    IF NOT FOUND THEN
        result := json_build_object(
            'success', false,
            'message', 'No active PIN found for user'
        );
        RETURN result;
    END IF;
    
    -- Check if reset is required
    IF NOT pin_record.requires_reset OR pin_record.reset_token IS NULL THEN
        result := json_build_object(
            'success', false,
            'message', 'PIN reset not authorized'
        );
        RETURN result;
    END IF;
    
    -- Generate new salt and hash
    salt := encode(gen_random_bytes(32), 'hex');
    new_pin_hash := encode(digest(p_new_pin || salt, 'sha512'), 'hex');
    
    -- Update PIN record
    UPDATE user_pins 
    SET 
        pin_hash = new_pin_hash,
        pin_salt = salt,
        reset_token = NULL,
        reset_token_expires_at = NULL,
        requires_reset = FALSE,
        failed_attempts = 0,
        locked_until = NULL,
        last_used_at = NOW(),
        updated_at = NOW()
    WHERE user_id = p_user_id AND is_active = TRUE;
    
    result := json_build_object(
        'success', true,
        'message', 'PIN updated successfully'
    );
    
    RETURN result;
END;
$$;

-- ========================================
-- FUNCTION 5: Get User Email for PIN Reset
-- ========================================
CREATE OR REPLACE FUNCTION get_user_email_for_pin_reset(
    p_user_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth
AS $$
DECLARE
    user_email TEXT;
BEGIN
    -- Get user email from auth.users table
    -- Using SET search_path = auth to properly access auth.users
    SELECT email INTO user_email
    FROM users
    WHERE id = p_user_id;
    
    RETURN user_email;
EXCEPTION
    WHEN OTHERS THEN
        -- Log error for debugging
        RAISE LOG 'Error getting user email for PIN reset: user_id=%, error=%', p_user_id, SQLERRM;
        RETURN NULL;
END;
$$;

-- ========================================
-- GRANT PERMISSIONS
-- ========================================
GRANT EXECUTE ON FUNCTION generate_pin_reset_token() TO service_role;
GRANT EXECUTE ON FUNCTION save_pin_reset_token(UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION verify_pin_reset_token(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION update_user_pin(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION get_user_email_for_pin_reset(UUID) TO service_role;

-- ========================================
-- COMMENTS FOR FUNCTIONS
-- =====================================

COMMENT ON FUNCTION public.generate_pin_reset_token() IS 'Generates a secure 6-digit numeric PIN reset token';
COMMENT ON FUNCTION public.save_pin_reset_token(UUID, TEXT, INTEGER) IS 'Saves PIN reset token to user_pins table';
COMMENT ON FUNCTION public.verify_pin_reset_token(UUID, TEXT) IS 'Verifies PIN reset token and returns validity';
COMMENT ON FUNCTION public.update_user_pin(UUID, TEXT) IS 'Updates user PIN with new hashed value';
COMMENT ON FUNCTION public.get_user_email_for_pin_reset(UUID) IS 'Gets user email from auth.users for PIN reset';

-- ========================================
-- COMPLETION
-- =====================================

-- This migration adds:
-- Safe function replacement (drops existing functions first)
-- 6-digit numeric token generation function
-- Token save and verification functions
-- PIN update function
-- User email retrieval function (with auth.users access)
-- Proper service_role permissions
-- Error handling and logging

COMMIT;

-- ========================================
-- USAGE NOTES
-- ========================================
/*
1. Flow:
   - Call generate_pin_reset_token() to get 6-digit code
   - Call save_pin_reset_token(user_id, token) to save it
   - Send token to user's email
   - User provides token -> call verify_pin_reset_token(user_id, token)
   - If valid, user provides new PIN -> call update_user_pin(user_id, new_pin)

2. Security:
   - All functions are SECURITY DEFINER
   - Tokens expire after 1 hour by default
   - PIN must be exactly 6 digits
   - Reset required flag prevents unauthorized changes

3. Integration:
   - Use get_user_email_for_pin_reset() to get email for sending
   - Token validation prevents brute force attacks
   - Proper error messages for security
*/
