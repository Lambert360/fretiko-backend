BEGIN;

-- =====================================================
-- LIVE STREAM SOUNDBOARD
-- Migration: 221
-- Description: Extends the reusable `sounds` catalog so it can hold
-- platform-curated live-stream sound effects AND vendor-owned uploads,
-- without gift sounds leaking into the live-stream soundboard (or vice
-- versa).
--
--   owner_id  NULL  -> platform/admin sound (managed via /gifts/admin/sounds)
--   owner_id  SET   -> vendor-owned sound (managed via /sounds/live-stream/*)
--   context   'gift' | 'live_stream' -> which surface the sound is for
-- =====================================================

ALTER TABLE sounds
  ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS context VARCHAR(30) NOT NULL DEFAULT 'gift';

ALTER TABLE sounds
  DROP CONSTRAINT IF EXISTS sounds_context_check;

ALTER TABLE sounds
  ADD CONSTRAINT sounds_context_check CHECK (context IN ('gift', 'live_stream'));

-- All existing rows are gift sounds; platform rows keep owner_id NULL.
-- (Defaults above already produce this state — the UPDATEs below are a
-- defensive no-op for clarity if defaults ever change.)
UPDATE sounds SET context = 'gift' WHERE context IS NULL;

CREATE INDEX IF NOT EXISTS idx_sounds_context ON sounds(context);
CREATE INDEX IF NOT EXISTS idx_sounds_owner_id ON sounds(owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sounds_context_owner ON sounds(context, owner_id);

COMMIT;
