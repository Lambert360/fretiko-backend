-- =====================================================
-- ADD GOOGLE OAUTH PROVIDER
-- =====================================================
-- Migration: Configure Google OAuth provider for Supabase Auth
-- Description: Enables Google sign-in functionality
-- Date: 2026-03-02

-- =====================================================
-- ENABLE GOOGLE OAUTH PROVIDER
-- =====================================================

-- Note: This migration sets up the Google OAuth provider configuration
-- The actual provider configuration must be done via Supabase Dashboard:
-- 1. Go to Authentication > Providers > Google
-- 2. Enable Google provider
-- 3. Add your Google OAuth Client ID and Secret
-- 4. Configure redirect URLs

-- For local development, add: http://localhost:3000/auth/callback
-- For production, add: https://yourdomain.com/auth/callback

-- =====================================================
-- CREATE SOCIAL AUTH LOGS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS public.social_auth_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    provider VARCHAR(20) NOT NULL CHECK (provider IN ('google', 'apple')),
    provider_user_id VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    action VARCHAR(20) NOT NULL CHECK (action IN ('signup', 'signin', 'link', 'unlink')),
    ip_address VARCHAR(45),
    user_agent TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- CREATE INDEXES
-- =====================================================

-- Indexes for social auth logs
CREATE INDEX IF NOT EXISTS idx_social_auth_logs_user_id ON public.social_auth_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_social_auth_logs_provider ON public.social_auth_logs(provider);
CREATE INDEX IF NOT EXISTS idx_social_auth_logs_provider_user_id ON public.social_auth_logs(provider, provider_user_id);
CREATE INDEX IF NOT EXISTS idx_social_auth_logs_created_at ON public.social_auth_logs(created_at DESC);

-- =====================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================

-- Enable RLS for social auth logs
ALTER TABLE public.social_auth_logs ENABLE ROW LEVEL SECURITY;

-- Users can view their own social auth logs
CREATE POLICY "Users can view own social auth logs" ON public.social_auth_logs
FOR SELECT USING (auth.uid() = user_id);

-- Staff can view all social auth logs (handled via service role in backend)
-- No INSERT/UPDATE/DELETE policies for users - only staff via backend

-- =====================================================
-- CREATE SOCIAL AUTH FUNCTIONS
-- =====================================================

-- Function to handle new user from social provider (with inlined logging)
CREATE OR REPLACE FUNCTION public.handle_social_user()
RETURNS TRIGGER AS $$
DECLARE
    provider_name TEXT;
    provider_user_id TEXT;
BEGIN
    -- Extract provider info from raw_user_meta_data
    provider_name := NEW.raw_user_meta_data->>'provider';
    provider_user_id := NEW.raw_user_meta_data->>'provider_id';

    -- Inline social authentication logging to avoid function dependencies
    IF provider_name IS NOT NULL AND provider_user_id IS NOT NULL THEN
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
            NEW.id,
            provider_name,
            provider_user_id,
            NEW.email,
            'signup',
            inet_client_addr(),
            NULL, -- User agent not available in trigger
            jsonb_build_object(
                'created_at', NOW(),
                'email_confirmed', NEW.email_confirmed
            )
        );
    END IF;

    -- Insert user profile with social auth indicator
    INSERT INTO public.user_profiles (
        id,
        username,
        user_role,
        gender,
        preferences
    ) VALUES (
        NEW.id,
        COALESCE(
            NEW.raw_user_meta_data->>'username',
            LOWER(SPLIT_PART(NEW.email, '@', 1))
        ),
        COALESCE(NEW.raw_user_meta_data->>'user_role', 'citizen'),
        NEW.raw_user_meta_data->>'gender',
        jsonb_build_object(
            'auth_provider', provider_name,
            'social_auth', true
        )
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- CREATE TRIGGER FOR SOCIAL AUTH
-- =====================================================

-- Create trigger to handle new social auth users
-- Note: This trigger will be activated when users sign up via Google/Apple
DROP TRIGGER IF EXISTS on_auth_user_created_social ON auth.users;
CREATE TRIGGER on_auth_user_created_social
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_social_user();

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON TABLE public.social_auth_logs IS 'Tracks social authentication activities for security and audit purposes';
COMMENT ON COLUMN public.social_auth_logs.provider IS 'Social auth provider: google, apple';
COMMENT ON COLUMN public.social_auth_logs.provider_user_id IS 'User ID from the social provider';
COMMENT ON COLUMN public.social_auth_logs.action IS 'Type of auth action: signup, signin, link, unlink';
COMMENT ON COLUMN public.social_auth_logs.metadata IS 'Additional metadata about the auth attempt';

COMMENT ON FUNCTION public.handle_social_user() IS 'Handles new user creation from social providers with inlined logging';

-- =====================================================
-- COMPLETION
-- =====================================================

-- This migration adds:
-- ✅ Social auth logging system
-- ✅ Function to handle Google/Apple authentication (with inlined logging)
-- ✅ Trigger for social user creation
-- ✅ Proper RLS policies following app security model
-- ✅ Audit trail for social authentication

-- NOTE: Complete the setup in Supabase Dashboard:
-- 1. Enable Google provider in Authentication > Providers
-- 2. Add Google OAuth credentials
-- 3. Configure redirect URLs

COMMIT;
