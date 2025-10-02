-- Migration: Add chat management and user status columns
-- Run this in Supabase SQL Editor

BEGIN;

-- ========================================
-- ADD MISSING COLUMNS TO chat_participants
-- ========================================

-- Add archived status columns
ALTER TABLE public.chat_participants
ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- Add pinned timestamp (is_pinned already exists)
ALTER TABLE public.chat_participants
ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

-- Add muted timestamp (is_muted already exists)
ALTER TABLE public.chat_participants
ADD COLUMN IF NOT EXISTS muted_at TIMESTAMPTZ;

-- Add helpful comments
COMMENT ON COLUMN public.chat_participants.is_archived IS 'Whether this conversation is archived for this user';
COMMENT ON COLUMN public.chat_participants.archived_at IS 'When this conversation was archived by this user';
COMMENT ON COLUMN public.chat_participants.pinned_at IS 'When this conversation was pinned by this user';
COMMENT ON COLUMN public.chat_participants.muted_at IS 'When this conversation was muted by this user';

-- ========================================
-- ADD USER STATUS COLUMNS TO user_profiles
-- ========================================

-- Add online status and last seen columns
ALTER TABLE public.user_profiles
ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT NOW();

-- Add helpful comments
COMMENT ON COLUMN public.user_profiles.is_online IS 'Whether the user is currently online and connected';
COMMENT ON COLUMN public.user_profiles.last_seen IS 'Last time the user was seen online or active';

-- ========================================
-- CREATE INDEXES FOR PERFORMANCE
-- ========================================

-- Indexes for chat_participants filtering
CREATE INDEX IF NOT EXISTS chat_participants_is_archived_idx ON public.chat_participants(is_archived);
CREATE INDEX IF NOT EXISTS chat_participants_is_pinned_idx ON public.chat_participants(is_pinned);
CREATE INDEX IF NOT EXISTS chat_participants_is_muted_idx ON public.chat_participants(is_muted);
CREATE INDEX IF NOT EXISTS chat_participants_archived_at_idx ON public.chat_participants(archived_at);
CREATE INDEX IF NOT EXISTS chat_participants_pinned_at_idx ON public.chat_participants(pinned_at);

-- Composite index for conversation queries
CREATE INDEX IF NOT EXISTS chat_participants_user_conversation_status_idx
ON public.chat_participants(user_id, is_archived, is_pinned);

-- Indexes for user status
CREATE INDEX IF NOT EXISTS user_profiles_is_online_idx ON public.user_profiles(is_online);
CREATE INDEX IF NOT EXISTS user_profiles_last_seen_idx ON public.user_profiles(last_seen);

-- ========================================
-- CREATE FUNCTIONS FOR AUTOMATION
-- ========================================

-- Function to update archived_at when is_archived changes
CREATE OR REPLACE FUNCTION update_archived_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    -- If is_archived is being set to TRUE, set archived_at
    IF NEW.is_archived = TRUE AND OLD.is_archived = FALSE THEN
        NEW.archived_at = NOW();
    -- If is_archived is being set to FALSE, clear archived_at
    ELSIF NEW.is_archived = FALSE AND OLD.is_archived = TRUE THEN
        NEW.archived_at = NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to update pinned_at when is_pinned changes
CREATE OR REPLACE FUNCTION update_pinned_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    -- If is_pinned is being set to TRUE, set pinned_at
    IF NEW.is_pinned = TRUE AND (OLD.is_pinned = FALSE OR OLD.is_pinned IS NULL) THEN
        NEW.pinned_at = NOW();
    -- If is_pinned is being set to FALSE, clear pinned_at
    ELSIF NEW.is_pinned = FALSE AND OLD.is_pinned = TRUE THEN
        NEW.pinned_at = NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to update muted_at when is_muted changes
CREATE OR REPLACE FUNCTION update_muted_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    -- If is_muted is being set to TRUE, set muted_at
    IF NEW.is_muted = TRUE AND (OLD.is_muted = FALSE OR OLD.is_muted IS NULL) THEN
        NEW.muted_at = NOW();
    -- If is_muted is being set to FALSE, clear muted_at
    ELSIF NEW.is_muted = FALSE AND OLD.is_muted = TRUE THEN
        NEW.muted_at = NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to update last_seen when user goes offline
CREATE OR REPLACE FUNCTION update_last_seen_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    -- Update last_seen whenever is_online changes or when explicitly updated
    IF NEW.is_online != OLD.is_online OR NEW.last_seen IS DISTINCT FROM OLD.last_seen THEN
        -- If going offline, update last_seen to current time
        IF NEW.is_online = FALSE AND OLD.is_online = TRUE THEN
            NEW.last_seen = NOW();
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ========================================
-- CREATE TRIGGERS
-- ========================================

-- Create triggers for chat_participants timestamp updates
CREATE TRIGGER update_chat_participants_archived_timestamp
    BEFORE UPDATE ON public.chat_participants
    FOR EACH ROW
    EXECUTE FUNCTION update_archived_timestamp();

CREATE TRIGGER update_chat_participants_pinned_timestamp
    BEFORE UPDATE ON public.chat_participants
    FOR EACH ROW
    EXECUTE FUNCTION update_pinned_timestamp();

CREATE TRIGGER update_chat_participants_muted_timestamp
    BEFORE UPDATE ON public.chat_participants
    FOR EACH ROW
    EXECUTE FUNCTION update_muted_timestamp();

-- Create trigger for user status updates
CREATE TRIGGER update_user_profiles_last_seen_timestamp
    BEFORE UPDATE ON public.user_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_last_seen_timestamp();

-- ========================================
-- UPDATE EXISTING DATA (IF NEEDED)
-- ========================================

-- Set pinned_at for existing pinned conversations
UPDATE public.chat_participants
SET pinned_at = NOW()
WHERE is_pinned = TRUE AND pinned_at IS NULL;

-- Set muted_at for existing muted conversations
UPDATE public.chat_participants
SET muted_at = NOW()
WHERE is_muted = TRUE AND muted_at IS NULL;

-- Initialize last_seen for all users who don't have it set
UPDATE public.user_profiles
SET last_seen = created_at
WHERE last_seen IS NULL;

-- ========================================
-- ADD VALIDATION CONSTRAINTS
-- ========================================

-- Ensure archived_at is only set when is_archived is true
ALTER TABLE public.chat_participants
ADD CONSTRAINT check_archived_at_consistency
CHECK ((is_archived = TRUE AND archived_at IS NOT NULL) OR (is_archived = FALSE AND archived_at IS NULL));

-- Ensure pinned_at is only set when is_pinned is true
ALTER TABLE public.chat_participants
ADD CONSTRAINT check_pinned_at_consistency
CHECK ((is_pinned = TRUE AND pinned_at IS NOT NULL) OR (is_pinned = FALSE AND pinned_at IS NULL));

-- Ensure muted_at is only set when is_muted is true
ALTER TABLE public.chat_participants
ADD CONSTRAINT check_muted_at_consistency
CHECK ((is_muted = TRUE AND muted_at IS NOT NULL) OR (is_muted = FALSE AND muted_at IS NULL));

COMMIT;