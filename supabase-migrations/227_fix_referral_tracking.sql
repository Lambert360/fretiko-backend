-- Migration: Fix referral click tracking and multi-referral completion
--
-- Bug 1: track_referral_click() uses ON CONFLICT (referrer_id, referral_code)
--        but no unique constraint exists on that pair -> Postgres 42P10
--        "no unique or exclusion constraint matching the ON CONFLICT
--        specification" on EVERY valid code. Every real referral click
--        failed -> the web landing page reported a valid link as invalid.
--
-- Bug 2: complete_referral() fills referred_user_id on the single
--        (referrer_id, referral_code) row, so only ONE referred user could
--        ever be recorded per code; subsequent referrals silently no-op'd.
--
-- Model: at most one "pending" click-aggregate row per (referrer, code)
--        (referred_user_id IS NULL). Each completed referral consumes that
--        pending row, or inserts its own completed row if none exists.
--
-- Date: 2026-09-23

BEGIN;

-- Defensive dedup: merge duplicate pending rows for the same
-- (referrer, code) before the unique index is created. There should be
-- none — every track_referral_click call has been erroring at this
-- INSERT — but hand-inserted or seeded rows would abort the index build.
WITH ranked AS (
    SELECT id,
           referrer_id,
           referral_code,
           click_count,
           first_click_at,
           ROW_NUMBER() OVER (
               PARTITION BY referrer_id, referral_code
               ORDER BY created_at
           ) AS rn
    FROM public.referrals
    WHERE referred_user_id IS NULL
),
keeper AS (
    SELECT id, referrer_id, referral_code, first_click_at
    FROM ranked WHERE rn = 1
),
dupes AS (
    SELECT id, referrer_id, referral_code, click_count, first_click_at
    FROM ranked WHERE rn > 1
),
merged AS (
    UPDATE public.referrals r
    SET click_count = r.click_count + COALESCE(d.total_extra_clicks, 0),
        first_click_at = LEAST(r.first_click_at, d.earliest_click)
    FROM (
        SELECT k.id AS keeper_id,
               SUM(d.click_count) AS total_extra_clicks,
               MIN(d.first_click_at) AS earliest_click
        FROM keeper k
        JOIN dupes d
          ON d.referrer_id = k.referrer_id
         AND d.referral_code = k.referral_code
        GROUP BY k.id
    ) d
    WHERE r.id = d.keeper_id
    RETURNING r.id
)
DELETE FROM public.referrals r
USING dupes d
WHERE r.id = d.id;

-- Unique pending row per (referrer, code) — completed rows have a
-- referred_user_id and are intentionally outside the index so multiple
-- completed referrals per code are allowed.
CREATE UNIQUE INDEX IF NOT EXISTS referrals_pending_per_code
ON public.referrals (referrer_id, referral_code)
WHERE referred_user_id IS NULL;

-- Supports the case-insensitive username-alias lookups below
-- (LOWER(username) = LOWER(input) can't use the plain UNIQUE index).
CREATE INDEX IF NOT EXISTS user_profiles_username_lower
ON public.user_profiles (LOWER(username));

CREATE OR REPLACE FUNCTION public.track_referral_click(p_referral_code VARCHAR)
RETURNS JSONB AS $$
DECLARE
    v_referrer_id UUID;
    v_code VARCHAR(10);
BEGIN
    -- Find referrer by referral code or username (usernames are shared
    -- as human-readable referral slugs; codes keep working forever).
    -- The canonical referral_code is stored, not the slug used.
    -- LOWER() = LOWER() rather than ILIKE so '_'/'%' in a username
    -- aren't treated as wildcards.
    SELECT id, referral_code INTO v_referrer_id, v_code
    FROM public.user_profiles
    WHERE referral_code = p_referral_code
       OR LOWER(username) = LOWER(p_referral_code)
    ORDER BY (referral_code = p_referral_code) DESC
    LIMIT 1;

    IF v_referrer_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Invalid referral code'
        );
    END IF;

    -- Heal missing codes (e.g. referrer matched by username but has none)
    IF v_code IS NULL THEN
        v_code := public.generate_referral_code();
        UPDATE public.user_profiles
        SET referral_code = v_code
        WHERE id = v_referrer_id;
    END IF;

    -- Upsert the pending click-aggregate row
    INSERT INTO public.referrals (
        referrer_id,
        referral_code,
        status,
        click_count,
        first_click_at
    ) VALUES (
        v_referrer_id,
        v_code,
        'pending',
        1,
        NOW()
    )
    ON CONFLICT (referrer_id, referral_code) WHERE referred_user_id IS NULL
    DO UPDATE SET
        click_count = referrals.click_count + 1,
        first_click_at = COALESCE(referrals.first_click_at, NOW());

    RETURN jsonb_build_object(
        'success', true,
        'referrer_id', v_referrer_id,
        'referral_code', v_code
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION public.complete_referral(
    p_referred_user_id UUID,
    p_referral_code VARCHAR
)
RETURNS JSONB AS $$
DECLARE
    v_referrer_id UUID;
    v_code VARCHAR(10);
BEGIN
    -- Find referrer by referral code or username (exact match wins)
    SELECT id, referral_code INTO v_referrer_id, v_code
    FROM public.user_profiles
    WHERE referral_code = p_referral_code
       OR LOWER(username) = LOWER(p_referral_code)
    ORDER BY (referral_code = p_referral_code) DESC
    LIMIT 1;

    IF v_referrer_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Invalid referral code'
        );
    END IF;

    -- A user cannot refer themselves
    IF v_referrer_id = p_referred_user_id THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Cannot use your own referral code'
        );
    END IF;

    -- A user can only be attributed once — repeat calls are no-ops so
    -- stats and referred_by_code can't be inflated or overwritten.
    IF EXISTS (
        SELECT 1 FROM public.referrals
        WHERE referred_user_id = p_referred_user_id
    ) THEN
        RETURN jsonb_build_object(
            'success', true,
            'referrer_id', v_referrer_id,
            'already_referred', true
        );
    END IF;

    -- Heal missing codes (e.g. referrer matched by username but has none)
    IF v_code IS NULL THEN
        v_code := public.generate_referral_code();
        UPDATE public.user_profiles
        SET referral_code = v_code
        WHERE id = v_referrer_id;
    END IF;

    -- Update referred user's profile (canonical code, not the slug used)
    UPDATE public.user_profiles
    SET referred_by_code = v_code
    WHERE id = p_referred_user_id
      AND referred_by_code IS NULL;

    -- Consume the pending click row for this code...
    UPDATE public.referrals
    SET
        referred_user_id = p_referred_user_id,
        status = 'completed',
        completed_at = NOW(),
        signup_attempts = signup_attempts + 1
    WHERE referrer_id = v_referrer_id
      AND referral_code = v_code
      AND referred_user_id IS NULL;

    -- ...or record the completed referral directly if no click was tracked
    IF NOT FOUND THEN
        INSERT INTO public.referrals (
            referrer_id,
            referred_user_id,
            referral_code,
            status,
            signup_attempts,
            completed_at
        ) VALUES (
            v_referrer_id,
            p_referred_user_id,
            v_code,
            'completed',
            1,
            NOW()
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'referrer_id', v_referrer_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMIT;
