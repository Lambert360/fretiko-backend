-- =====================================================
-- ADD APPLE OAUTH PROVIDER
-- =====================================================
-- Migration: Configure Apple OAuth provider for Supabase Auth
-- Description: Enables Apple sign-in functionality
-- Date: 2026-03-02

-- =====================================================
-- ENABLE APPLE OAUTH PROVIDER
-- =====================================================

-- Note: This migration documents Apple OAuth provider setup
-- The actual provider configuration must be done via Supabase Dashboard:
-- 1. Go to Authentication > Providers > Apple
-- 2. Enable Apple provider
-- 3. Add your Apple Sign In credentials
-- 4. Configure redirect URLs

-- For local development, add: http://localhost:3000/auth/callback
-- For production, add: https://yourdomain.com/auth/callback

-- Apple Sign In requires:
-- - Apple Developer Account
-- - App ID with Sign In capability
-- - Service ID for web authentication
-- - Private key for JWT signing

-- =====================================================
-- UPDATE SOCIAL AUTH LOGS FOR APPLE SUPPORT
-- =====================================================

-- The social_auth_logs table already supports Apple provider
-- No additional schema changes needed

-- =====================================================
-- APPLE-SPECIFIC CONSIDERATIONS
-- =====================================================

-- Apple provides limited user information:
-- - Email (if user grants permission)
-- - Name (only on first sign-in, user can choose to hide)
-- - Unique Apple ID (stable identifier)

-- Apple users can:
-- - Hide their email (Apple provides private relay email)
-- - Change their private relay email
-- - Sign in without sharing name

-- =====================================================
-- UPDATE USER PROFILE HANDLING FOR APPLE
-- =====================================================

-- Function to handle Apple-specific user data
CREATE OR REPLACE FUNCTION public.handle_apple_user_data()
RETURNS TRIGGER AS $$
DECLARE
    is_apple_user BOOLEAN;
    apple_email_hidden BOOLEAN;
BEGIN
    -- Check if this is an Apple user
    is_apple_user := NEW.raw_user_meta_data->>'provider' = 'apple';
    
    IF is_apple_user THEN
        -- Check if email is hidden (Apple private relay)
        apple_email_hidden := NEW.email LIKE '%@privaterelay.appleid.com';
        
        -- Update user preferences with Apple-specific settings
        UPDATE public.user_profiles 
        SET preferences = preferences || jsonb_build_object(
            'auth_provider', 'apple',
            'social_auth', true,
            'apple_email_hidden', apple_email_hidden,
            'apple_signin_at', NOW()
        )
        WHERE id = NEW.id;
        
        -- Log Apple-specific authentication
        PERFORM public.log_social_auth(
            NEW.id,
            'apple',
            NEW.raw_user_meta_data->>'provider_id',
            NEW.email,
            'signup',
            inet_client_addr(),
            NULL,
            jsonb_build_object(
                'apple_email_hidden', apple_email_hidden,
                'email_domain', SPLIT_PART(NEW.email, '@', 2),
                'created_at', NOW()
            )
        );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- CREATE TRIGGER FOR APPLE-SPECIFIC HANDLING
-- =====================================================

-- Create trigger for Apple user handling
DROP TRIGGER IF EXISTS on_apple_user_created ON auth.users;
CREATE TRIGGER on_apple_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    WHEN (NEW.raw_user_meta_data->>'provider' = 'apple')
    EXECUTE FUNCTION public.handle_apple_user_data();

-- =====================================================
-- CREATE FUNCTION FOR APPLE EMAIL UPDATES
-- =====================================================

-- Function to handle when Apple user changes their private relay email
CREATE OR REPLACE FUNCTION public.handle_apple_email_update()
RETURNS TRIGGER AS $$
DECLARE
    is_apple_user BOOLEAN;
    is_private_relay BOOLEAN;
BEGIN
    -- Check if this is an Apple user with private relay email
    is_private_relay := NEW.email LIKE '%@privaterelay.appleid.com';
    
    IF is_private_relay THEN
        -- Update user preferences with new email
        UPDATE public.user_profiles 
        SET preferences = preferences || jsonb_build_object(
            'apple_email_updated_at', NOW(),
            'apple_email_previous', OLD.email,
            'apple_email_current', NEW.email
        )
        WHERE id = NEW.id;
        
        -- Log email change
        PERFORM public.log_social_auth(
            NEW.id,
            'apple',
            NULL, -- Provider ID doesn't change
            NEW.email,
            'email_update',
            inet_client_addr(),
            NULL,
            jsonb_build_object(
                'previous_email', OLD.email,
                'new_email', NEW.email,
                'updated_at', NOW()
            )
        );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- CREATE TRIGGER FOR APPLE EMAIL UPDATES
-- =====================================================

-- Create trigger for Apple email updates
DROP TRIGGER IF EXISTS on_apple_email_updated ON auth.users;
CREATE TRIGGER on_apple_email_updated
    AFTER UPDATE OF email ON auth.users
    FOR EACH ROW
    WHEN (OLD.email IS DISTINCT FROM NEW.email AND NEW.email LIKE '%@privaterelay.appleid.com')
    EXECUTE FUNCTION public.handle_apple_email_update();

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON FUNCTION public.handle_apple_user_data() IS 'Handles Apple-specific user data and privacy settings';
COMMENT ON FUNCTION public.handle_apple_email_update() IS 'Tracks Apple private relay email changes';

-- =====================================================
-- COMPLETION
-- =====================================================

-- This migration adds:
-- ✅ Apple OAuth provider support
-- ✅ Apple-specific user data handling
-- ✅ Private relay email tracking
-- ✅ Apple user privacy considerations
-- ✅ Email change monitoring for Apple users

-- NOTE: Complete the setup in Supabase Dashboard:
-- 1. Enable Apple provider in Authentication > Providers
-- 2. Add Apple Sign In credentials
-- 3. Configure redirect URLs
-- 4. Test with Apple Developer account

COMMIT;
