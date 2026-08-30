BEGIN;

-- =====================================================
-- ADD LOTTIE + SOUND ASSETS TO VIRTUAL GIFTS
-- Migration: 167
-- Description: Adds sounds catalog and Lottie asset fields to virtual_gifts
-- =====================================================

-- Reusable sounds catalog
CREATE TABLE IF NOT EXISTS sounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  sound_url TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add Lottie asset columns to virtual_gifts
ALTER TABLE virtual_gifts
  ADD COLUMN IF NOT EXISTS display_lottie_url TEXT,
  ADD COLUMN IF NOT EXISTS lottie_config JSONB,
  ADD COLUMN IF NOT EXISTS sound_id UUID REFERENCES sounds(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS animation_type VARCHAR(20) DEFAULT 'lottie_single';

-- Storage buckets for gift assets
INSERT INTO storage.buckets (id, name, public)
VALUES ('gift-lotties', 'gift-lotties', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('gift-sounds', 'gift-sounds', true)
ON CONFLICT (id) DO NOTHING;

COMMIT;
