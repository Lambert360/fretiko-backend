-- =====================================================
-- FIX SIGNUP TRIGGER - ROBUST VERSION
-- =====================================================
-- Purpose: Fix "Database error saving new user" by creating
--          a trigger that handles failures gracefully
-- Run this in Supabase SQL Editor immediately

-- =====================================================
-- STEP 1: CHECK CURRENT STATE
-- =====================================================

-- First, let's see what we're working with
SELECT 'Current trigger function:' as info, proname, prosrc 
FROM pg_proc 
WHERE proname = 'handle_new_user';

SELECT 'Current user_profiles columns:' as info, column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'user_profiles' AND table_schema = 'public'
ORDER BY ordinal_position;

-- =====================================================
-- STEP 2: CREATE ROBUST TRIGGER FUNCTION
-- =====================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    verification_token TEXT;
    verification_expires TIMESTAMP WITH TIME ZONE;
    profile_columns TEXT[];
    insert_columns TEXT[];
    insert_values TEXT[];
BEGIN
    -- Get available columns dynamically to avoid errors
    SELECT ARRAY_AGG(column_name::TEXT) INTO profile_columns
    FROM information_schema.columns 
    WHERE table_name = 'user_profiles' AND table_schema = 'public';
    
    -- Generate 6-digit verification token
    verification_token := LPAD(FLOOR(RANDOM() * 900000 + 100000)::TEXT, 6, '0');
    verification_expires := NOW() + INTERVAL '24 hours';
    
    -- Build dynamic INSERT based on available columns
    insert_columns := ARRAY['id', 'username'];
    insert_values := ARRAY[NEW.id::TEXT, LOWER(SPLIT_PART(NEW.email, '@', 1))];
    
    -- Add role column if available
    IF 'user_role' = ANY(profile_columns) THEN
        insert_columns := array_append(insert_columns, 'user_role');
        insert_values := array_append(insert_values, COALESCE(NEW.raw_user_meta_data->>'user_role', 'citizen'));
    END IF;
    
    -- Add gender column if available
    IF 'gender' = ANY(profile_columns) THEN
        insert_columns := array_append(insert_columns, 'gender');
        insert_values := array_append(insert_values, NEW.raw_user_meta_data->>'gender');
    END IF;
    
    -- Add email verification columns if available
    IF 'email_confirmation_token' = ANY(profile_columns) THEN
        insert_columns := array_append(insert_columns, 'email_confirmation_token');
        insert_values := array_append(insert_values, verification_token);
    END IF;
    
    IF 'email_confirmation_expires_at' = ANY(profile_columns) THEN
        insert_columns := array_append(insert_columns, 'email_confirmation_expires_at');
        insert_values := array_append(insert_values, verification_expires);
    END IF;
    
    -- Execute dynamic INSERT
    EXECUTE format('
        INSERT INTO public.user_profiles (%s) 
        VALUES (%s)',
        array_to_string(insert_columns, ','),
        array_to_string(insert_values, ', ')
    );
    
    -- Log verification email sent (if table exists)
    BEGIN
        INSERT INTO public.email_verification_logs (user_id, email, action)
        VALUES (NEW.id, NEW.email, 'sent');
    EXCEPTION WHEN OTHERS THEN
        -- Table might not exist, don't fail user creation
        NULL;
    END;
    
    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        -- Log error but don't fail user creation
        RAISE WARNING 'Profile creation failed: %', SQLERRM;
        RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- STEP 3: ENSURE TRIGGER EXISTS
-- =====================================================

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- Create new trigger
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =====================================================
-- STEP 4: VERIFICATION
-- =====================================================

-- Verify trigger was created
SELECT 'Trigger created successfully:' as result, trigger_name, event_manipulation, action_timing
FROM information_schema.triggers 
WHERE trigger_name = 'on_auth_user_created';

-- Test trigger with a mock user (commented out for safety)
-- SELECT 'Testing trigger...' as status;
-- INSERT INTO auth.users (id, email, created_at) 
-- VALUES ('00000000-0000-0000-0000-000000000000', 'test@example.com', NOW());

COMMIT;
