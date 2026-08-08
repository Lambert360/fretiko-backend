-- =====================================================
-- SOCIAL AUTHENTICATION SYSTEM (Google + Apple)
-- =====================================================
-- Migration: 163_social_auth_system.sql
-- Description: Creates social auth logging, fixes the
--              user-creation trigger to support Google/Apple
--              without breaking manual email-verification flow.
-- Replaces: 161_add_google_oauth_provider.sql
--           162_add_apple_oauth_provider.sql
-- Date: 2026-07-30

BEGIN;

-- =====================================================
-- EXTENSIONS
-- =====================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================
-- SOCIAL AUTH LOGS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS public.social_auth_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    provider VARCHAR(20) NOT NULL,
    provider_user_id VARCHAR(255),
    email VARCHAR(255),
    action VARCHAR(20) NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_auth_logs_user_id ON public.social_auth_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_social_auth_logs_provider ON public.social_auth_logs(provider);
CREATE INDEX IF NOT EXISTS idx_social_auth_logs_provider_user_id ON public.social_auth_logs(provider, provider_user_id);
CREATE INDEX IF NOT EXISTS idx_social_auth_logs_created_at ON public.social_auth_logs(created_at DESC);

ALTER TABLE public.social_auth_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'social_auth_logs'
          AND policyname = 'Users can view own social auth logs'
    ) THEN
        CREATE POLICY "Users can view own social auth logs" ON public.social_auth_logs
        FOR SELECT USING (auth.uid() = user_id);
    END IF;
END $$;

-- =====================================================
-- SOCIAL AUTH LOGGING FUNCTION (used by backend)
-- =====================================================

CREATE OR REPLACE FUNCTION public.log_social_auth(
    p_user_id UUID,
    p_provider VARCHAR,
    p_provider_user_id VARCHAR,
    p_email VARCHAR,
    p_action VARCHAR,
    p_ip_address VARCHAR,
    p_user_agent TEXT,
    p_metadata JSONB
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO public.social_auth_logs (
        user_id,
        provider,
        provider_user_id,
        email,
        action,
        ip_address,
        user_agent,
        metadata
    ) VALUES (
        p_user_id,
        p_provider,
        p_provider_user_id,
        p_email,
        p_action,
        p_ip_address,
        p_user_agent,
        COALESCE(p_metadata, '{}'::jsonb)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- CLEAN UP BUGGY SOCIAL AUTH TRIGGERS / FUNCTIONS
-- =====================================================

DROP TRIGGER IF EXISTS on_auth_user_created_social ON auth.users;
DROP TRIGGER IF EXISTS on_apple_user_created ON auth.users;
DROP TRIGGER IF EXISTS on_apple_email_updated ON auth.users;

DROP FUNCTION IF EXISTS public.handle_social_user();
DROP FUNCTION IF EXISTS public.handle_apple_user_data();
DROP FUNCTION IF EXISTS public.handle_apple_email_update();

-- =====================================================
-- ENSURE COLUMNS THE TRIGGER NEEDS
-- =====================================================

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS user_role VARCHAR(20),
    ADD COLUMN IF NOT EXISTS gender VARCHAR(20),
    ADD COLUMN IF NOT EXISTS email_confirmed BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS email_confirmation_token VARCHAR(255),
    ADD COLUMN IF NOT EXISTS email_confirmation_expires_at TIMESTAMP WITH TIME ZONE;

-- =====================================================
-- HANDLE NEW USER TRIGGER (SOCIAL + MANUAL)
-- =====================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    is_social BOOLEAN;
    base_username TEXT;
    final_username TEXT;
    verification_token TEXT;
    verification_expires TIMESTAMP WITH TIME ZONE;
BEGIN
    is_social := NEW.raw_user_meta_data->>'provider' IN ('google', 'apple');

    -- Derive a safe, unique, lowercase username
    base_username := COALESCE(
        LOWER(NEW.raw_user_meta_data->>'username'),
        LOWER(SPLIT_PART(NEW.email, '@', 1))
    );
    base_username := REGEXP_REPLACE(base_username, '[^a-z0-9_]', '', 'g');
    base_username := LEFT(base_username, 40);

    IF base_username = '' OR base_username IS NULL THEN
        base_username := 'user';
    END IF;

    final_username := base_username;
    WHILE EXISTS (
        SELECT 1
        FROM public.user_profiles
        WHERE LOWER(username) = LOWER(final_username)
    ) LOOP
        final_username := base_username || '_' || LOWER(TO_HEX(FLOOR(RANDOM() * 65536)::INT));
    END LOOP;

    IF is_social THEN
        -- Social users are already email-verified by the provider.
        -- Create a minimal profile; the backend will upsert the rest.
        INSERT INTO public.user_profiles (
            id,
            username,
            user_role,
            gender,
            display_name,
            email_confirmed,
            preferences
        ) VALUES (
            NEW.id,
            final_username,
            COALESCE(NEW.raw_user_meta_data->>'user_role', 'citizen'),
            NEW.raw_user_meta_data->>'gender',
            NEW.raw_user_meta_data->>'display_name',
            TRUE,
            jsonb_build_object(
                'auth_provider', NEW.raw_user_meta_data->>'provider',
                'social_auth', true
            )
        )
        ON CONFLICT (id) DO NOTHING;
    ELSE
        -- Manual sign-up: create profile, generate email verification token.
        INSERT INTO public.user_profiles (
            id,
            username,
            user_role,
            gender,
            display_name
        ) VALUES (
            NEW.id,
            final_username,
            COALESCE(NEW.raw_user_meta_data->>'user_role', 'citizen'),
            NEW.raw_user_meta_data->>'gender',
            NEW.raw_user_meta_data->>'display_name'
        )
        ON CONFLICT (id) DO NOTHING;

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

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON TABLE public.social_auth_logs IS 'Tracks social authentication (Google/Apple) activities';
COMMENT ON FUNCTION public.log_social_auth(UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, TEXT, JSONB) IS 'Logs a social auth event from the backend';
COMMENT ON FUNCTION public.handle_new_user() IS 'Creates user profile on auth.users insert; skips email verification for social users';

COMMIT;
