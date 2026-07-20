-- Migration: Add display_name column to user_profiles, backfill from auth.users, update trigger
-- This enables a simple fallback: username || display_name || 'Unknown'

BEGIN;

-- Ensure pgcrypto is available (needed by gen_random_bytes in the trigger)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================
-- 1. Add display_name column if it doesn't exist
-- =====================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_profiles'
      AND table_schema = 'public'
      AND column_name = 'display_name'
  ) THEN
    ALTER TABLE public.user_profiles ADD COLUMN display_name TEXT;
  END IF;
END $$;

-- =====================================================
-- 2. Backfill display_name from auth.users.raw_user_meta_data
-- =====================================================
UPDATE public.user_profiles up
SET display_name = au.raw_user_meta_data->>'display_name',
    updated_at = NOW()
FROM auth.users au
WHERE up.id = au.id
  AND (up.display_name IS NULL OR up.display_name = '')
  AND au.raw_user_meta_data->>'display_name' IS NOT NULL;

-- =====================================================
-- 3. Update handle_new_user trigger to populate display_name
-- =====================================================
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    verification_token TEXT;
    verification_expires TIMESTAMP WITH TIME ZONE;
    has_email_columns BOOLEAN;
    has_user_role_column BOOLEAN;
    has_gender_column BOOLEAN;
    has_display_name_column BOOLEAN;
BEGIN
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

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'user_profiles'
        AND table_schema = 'public'
        AND column_name = 'display_name'
    ) INTO has_display_name_column;

    -- Insert basic profile with available columns only
    IF has_user_role_column AND has_gender_column AND has_display_name_column THEN
        INSERT INTO public.user_profiles (id, username, user_role, gender, display_name)
        VALUES (
            NEW.id,
            COALESCE(
                NEW.raw_user_meta_data->>'username',
                LOWER(SPLIT_PART(NEW.email, '@', 1))
            ),
            COALESCE(NEW.raw_user_meta_data->>'user_role', 'citizen'),
            NEW.raw_user_meta_data->>'gender',
            NEW.raw_user_meta_data->>'display_name'
        );
    ELSIF has_user_role_column AND has_gender_column THEN
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
        verification_token := encode(gen_random_bytes(16), 'hex');
        verification_expires := NOW() + INTERVAL '24 hours';

        UPDATE public.user_profiles
        SET
            email_confirmed = FALSE,
            email_confirmation_token = verification_token,
            email_confirmation_expires_at = verification_expires
        WHERE id = NEW.id;

        INSERT INTO public.email_verification_logs (user_id, email, action)
        VALUES (NEW.id, NEW.email, 'sent')
        ON CONFLICT DO NOTHING;
    END IF;

    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'handle_new_user: profile creation failed for user %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

COMMENT ON FUNCTION public.handle_new_user() IS 'Safe version that handles profile creation with dynamic column detection, optional email verification, and display_name population from raw_user_meta_data';

COMMIT;
