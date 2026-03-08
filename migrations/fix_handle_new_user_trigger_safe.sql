-- =====================================================
-- FIX HANDLE_NEW_USER TRIGGER - SAFE VERSION
-- =====================================================
-- This fixes the "Database error saving new user" issue
-- by ensuring trigger only inserts into existing columns
-- and handles all dependencies safely

-- 1. Ensure required extensions are available
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. Drop existing trigger and function
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

-- 3. Create safe function that handles all scenarios
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    verification_token TEXT;
    verification_expires TIMESTAMP WITH TIME ZONE;
    has_email_columns BOOLEAN;
    has_user_role_column BOOLEAN;
    has_gender_column BOOLEAN;
BEGIN
    -- Check what columns actually exist
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user_profiles' 
        AND table_schema = 'public'
        AND column_name = 'email_confirmation_token'
    ) INTO has_email_columns;
    
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user_profiles' 
        AND table_schema = 'public'
        AND column_name = 'user_role'
    ) INTO has_user_role_column;
    
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user_profiles' 
        AND table_schema = 'public'
        AND column_name = 'gender'
    ) INTO has_gender_column;
    
    -- Insert basic profile with available columns only
    IF has_user_role_column AND has_gender_column THEN
        INSERT INTO public.user_profiles (id, username, user_role, gender)
        VALUES (
            NEW.id,
            COALESCE(
                NEW.raw_user_meta_data->>'username',
                LOWER(SPLIT_PART(NEW.email, '@', 1))
            ),
            COALESCE(NEW.raw_user_meta_data->>'user_role', 'citizen'),
            NEW.raw_user_meta_data->>'gender'
        );
    ELSIF has_user_role_column THEN
        INSERT INTO public.user_profiles (id, username, user_role)
        VALUES (
            NEW.id,
            COALESCE(
                NEW.raw_user_meta_data->>'username',
                LOWER(SPLIT_PART(NEW.email, '@', 1))
            ),
            COALESCE(NEW.raw_user_meta_data->>'user_role', 'citizen')
        );
    ELSE
        INSERT INTO public.user_profiles (id, username)
        VALUES (
            NEW.id,
            COALESCE(
                NEW.raw_user_meta_data->>'username',
                LOWER(SPLIT_PART(NEW.email, '@', 1))
            )
        );
    END IF;
    
    -- Handle email verification if columns exist
    IF has_email_columns THEN
        -- Generate verification token
        verification_token := encode(gen_random_bytes(16), 'hex');
        verification_expires := NOW() + INTERVAL '24 hours';
        
        -- Update profile with verification data
        UPDATE public.user_profiles 
        SET 
            email_confirmed = FALSE,
            email_confirmation_token = verification_token,
            email_confirmation_expires_at = verification_expires
        WHERE id = NEW.id;
        
        -- Log verification email sent
        INSERT INTO public.email_verification_logs (user_id, email, action)
        VALUES (NEW.id, NEW.email, 'sent')
        ON CONFLICT DO NOTHING;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4. Recreate trigger
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 5. Add comprehensive comments
COMMENT ON FUNCTION public.handle_new_user() IS 'Safe version that handles profile creation with dynamic column detection and optional email verification';

COMMIT;
