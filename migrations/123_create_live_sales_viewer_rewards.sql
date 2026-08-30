-- Migration: Create Live Sales Viewer Reward Progress & Extend Rewards Transactions
-- Date: 2026-08-25
-- Description: Tracks watch-reward progress per stream session and supports live_watch_reward transaction type

BEGIN;

-- ================================
-- VIEWER REWARD PROGRESS TABLE
-- ================================

CREATE TABLE IF NOT EXISTS live_stream_viewer_reward_progress (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,

    session_start TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    minutes_accrued INTEGER NOT NULL DEFAULT 0 CHECK (minutes_accrued >= 0),
    last_credited_at TIMESTAMP WITH TIME ZONE,
    total_credited_freti DECIMAL(18,6) NOT NULL DEFAULT 0 CHECK (total_credited_freti >= 0),

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(stream_id, user_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_viewer_reward_progress_stream_id ON live_stream_viewer_reward_progress(stream_id);
CREATE INDEX IF NOT EXISTS idx_viewer_reward_progress_user_id ON live_stream_viewer_reward_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_viewer_reward_progress_session_start ON live_stream_viewer_reward_progress(session_start);

-- Row Level Security
ALTER TABLE live_stream_viewer_reward_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own reward progress"
ON live_stream_viewer_reward_progress FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage viewer reward progress"
ON live_stream_viewer_reward_progress FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Grant permissions
GRANT SELECT ON live_stream_viewer_reward_progress TO authenticated;
GRANT ALL ON live_stream_viewer_reward_progress TO service_role;

-- ================================
-- EXTEND REWARDS TRANSACTIONS TYPE
-- ================================

-- Drop the existing unnamed check constraint on transaction_type if it exists.
-- We cannot rely on a fixed name because it was not named in the original migration,
-- so we use a DO block to drop any check constraint on this column and recreate it.
DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT conname INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = 'rewards_transactions'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%transaction_type%'
    LIMIT 1;

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE rewards_transactions DROP CONSTRAINT %I', constraint_name);
    END IF;
END $$;

-- Add named check constraint with the new live_watch_reward type
ALTER TABLE rewards_transactions
ADD CONSTRAINT rewards_transactions_transaction_type_check
CHECK (transaction_type IN (
    'monthly_credit',
    'purchase_redemption',
    'refund_reversal',
    'admin_adjustment',
    'expired_deduction',
    'live_watch_reward'
));

COMMIT;
