-- Migration: Create Referral System
-- Description: Full referral tracking system with codes, stats, and attribution
-- Date: 2026-08-12

BEGIN;

-- ================================
-- ADD REFERRAL CODE TO USER_PROFILES
-- ================================

ALTER TABLE public.user_profiles 
ADD COLUMN IF NOT EXISTS referral_code VARCHAR(10) UNIQUE;

ALTER TABLE public.user_profiles 
ADD COLUMN IF NOT EXISTS referred_by_code VARCHAR(10);

-- Create index for referral code lookups
CREATE INDEX IF NOT EXISTS idx_user_profiles_referral_code 
ON public.user_profiles(referral_code);

CREATE INDEX IF NOT EXISTS idx_user_profiles_referred_by 
ON public.user_profiles(referred_by_code);

-- ================================
-- CREATE REFERRALS TABLE
-- ================================

CREATE TABLE IF NOT EXISTS public.referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    referred_user_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
    referral_code VARCHAR(10) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' 
        CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
    
    -- Tracking
    click_count INTEGER NOT NULL DEFAULT 0,
    signup_attempts INTEGER NOT NULL DEFAULT 0,
    
    -- Reward tracking
    reward_amount DECIMAL(18,6) DEFAULT 0,
    reward_paid BOOLEAN DEFAULT FALSE,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    first_click_at TIMESTAMP WITH TIME ZONE,
    
    -- Metadata
    metadata JSONB DEFAULT '{}'
);

-- ================================
-- INDEXES
-- ================================

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id 
ON public.referrals(referrer_id);

CREATE INDEX IF NOT EXISTS idx_referrals_referred_user_id 
ON public.referrals(referred_user_id);

CREATE INDEX IF NOT EXISTS idx_referrals_referral_code 
ON public.referrals(referral_code);

CREATE INDEX IF NOT EXISTS idx_referrals_status 
ON public.referrals(status);

CREATE INDEX IF NOT EXISTS idx_referrals_created_at 
ON public.referrals(created_at DESC);

-- ================================
-- ROW LEVEL SECURITY (RLS)
-- ================================

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

-- Users can view their own referrals (both as referrer and referred)
CREATE POLICY "Users can view own referrals" ON public.referrals
FOR SELECT USING (
    auth.uid() IN (referrer_id, referred_user_id)
);

-- Service role can manage everything (backend access)
CREATE POLICY "Service role full access" ON public.referrals
FOR ALL TO service_role
USING (true);

-- ================================
-- FUNCTIONS
-- ================================

-- Generate unique referral code
CREATE OR REPLACE FUNCTION public.generate_referral_code()
RETURNS VARCHAR(10) AS $$
DECLARE
    v_code VARCHAR(10);
    v_exists INTEGER;
    v_chars VARCHAR := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- No I, O, 0, 1 for clarity
    v_length INTEGER := 7;
BEGIN
    LOOP
        -- Generate random code
        v_code := '';
        FOR i IN 1..v_length LOOP
            v_code := v_code || SUBSTRING(v_chars, FLOOR(RANDOM() * LENGTH(v_chars) + 1)::INTEGER, 1);
        END LOOP;
        
        -- Check if unique
        SELECT COUNT(*) INTO v_exists 
        FROM public.user_profiles 
        WHERE referral_code = v_code;
        
        EXIT WHEN v_exists = 0;
    END LOOP;
    
    RETURN v_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Assign referral code to new users (trigger)
CREATE OR REPLACE FUNCTION public.assign_referral_code()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.referral_code IS NULL THEN
        NEW.referral_code := public.generate_referral_code();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Track referral click
CREATE OR REPLACE FUNCTION public.track_referral_click(p_referral_code VARCHAR)
RETURNS JSONB AS $$
DECLARE
    v_referrer_id UUID;
    v_result JSONB;
BEGIN
    -- Find referrer by code
    SELECT id INTO v_referrer_id
    FROM public.user_profiles
    WHERE referral_code = p_referral_code;
    
    IF v_referrer_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Invalid referral code'
        );
    END IF;
    
    -- Update or create referral record
    INSERT INTO public.referrals (
        referrer_id, 
        referral_code, 
        status, 
        click_count, 
        first_click_at
    ) VALUES (
        v_referrer_id, 
        p_referral_code, 
        'pending', 
        1, 
        NOW()
    )
    ON CONFLICT (referrer_id, referral_code) 
    DO UPDATE SET
        click_count = referrals.click_count + 1,
        first_click_at = COALESCE(referrals.first_click_at, NOW())
    WHERE referrals.referrer_id = v_referrer_id
      AND referrals.referral_code = p_referral_code;
    
    RETURN jsonb_build_object(
        'success', true,
        'referrer_id', v_referrer_id,
        'referral_code', p_referral_code
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Complete referral when user signs up
CREATE OR REPLACE FUNCTION public.complete_referral(
    p_referred_user_id UUID,
    p_referral_code VARCHAR
)
RETURNS JSONB AS $$
DECLARE
    v_referrer_id UUID;
    v_result JSONB;
BEGIN
    -- Find referrer
    SELECT id INTO v_referrer_id
    FROM public.user_profiles
    WHERE referral_code = p_referral_code;
    
    IF v_referrer_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Invalid referral code'
        );
    END IF;
    
    -- Update referred user's profile
    UPDATE public.user_profiles
    SET referred_by_code = p_referral_code
    WHERE id = p_referred_user_id;
    
    -- Update referral record
    UPDATE public.referrals
    SET 
        referred_user_id = p_referred_user_id,
        status = 'completed',
        completed_at = NOW(),
        signup_attempts = signup_attempts + 1
    WHERE referrer_id = v_referrer_id
      AND referral_code = p_referral_code
      AND referred_user_id IS NULL;
    
    RETURN jsonb_build_object(
        'success', true,
        'referrer_id', v_referrer_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get referral stats for a user
CREATE OR REPLACE FUNCTION public.get_referral_stats(p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_total_referrals INTEGER;
    v_completed_referrals INTEGER;
    v_pending_referrals INTEGER;
    v_total_clicks INTEGER;
    v_total_rewards DECIMAL(18,6);
BEGIN
    SELECT 
        COUNT(*),
        COUNT(*) FILTER (WHERE status = 'completed'),
        COUNT(*) FILTER (WHERE status = 'pending'),
        COALESCE(SUM(click_count), 0),
        COALESCE(SUM(reward_amount), 0)
    INTO 
        v_total_referrals,
        v_completed_referrals,
        v_pending_referrals,
        v_total_clicks,
        v_total_rewards
    FROM public.referrals
    WHERE referrer_id = p_user_id;
    
    RETURN jsonb_build_object(
        'total_referrals', v_total_referrals,
        'completed_referrals', v_completed_referrals,
        'pending_referrals', v_pending_referrals,
        'total_clicks', v_total_clicks,
        'total_rewards', v_total_rewards
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ================================
-- TRIGGERS
-- ================================

-- Auto-assign referral code on user creation
DROP TRIGGER IF EXISTS on_user_profile_created ON public.user_profiles;
CREATE TRIGGER on_user_profile_created
AFTER INSERT ON public.user_profiles
FOR EACH ROW EXECUTE FUNCTION public.assign_referral_code();

-- ================================
-- COMMENTS
-- ================================

COMMENT ON TABLE public.referrals IS 'Tracks referral relationships and attribution';
COMMENT ON COLUMN public.referrals.status IS 'pending: clicked but not signed up, completed: user signed up, failed: signup failed, cancelled: referral cancelled';
COMMENT ON COLUMN public.referrals.click_count IS 'Number of times referral link was clicked';
COMMENT ON COLUMN public.referrals.reward_amount IS 'Reward amount for successful referral';
COMMENT ON COLUMN public.user_profiles.referral_code IS 'Unique referral code for this user';
COMMENT ON COLUMN public.user_profiles.referred_by_code IS 'Referral code of user who referred this user';

-- ================================
-- BACKFILL REFERRAL CODES FOR EXISTING USERS
-- ================================

DO $$
DECLARE
    user_record RECORD;
BEGIN
    FOR user_record IN 
        SELECT id FROM public.user_profiles 
        WHERE referral_code IS NULL
        LIMIT 1000 -- Process in batches
    LOOP
        BEGIN
            UPDATE public.user_profiles
            SET referral_code = public.generate_referral_code()
            WHERE id = user_record.id;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'Failed to assign referral code for user %: %', user_record.id, SQLERRM;
        END;
    END LOOP;
END $$;

COMMIT;
