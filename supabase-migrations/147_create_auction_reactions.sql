BEGIN;

-- =====================================================
-- CREATE AUCTION REACTIONS SYSTEM
-- Migration: 147
-- Date: 2025-01-20
-- Description: Real-time reactions system for live auctions
-- Allows viewers to send reactions (hearts, applause, thumbs up, fire)
-- to provide feedback to auctioneers without comments
-- =====================================================

-- Create auction_reactions table
CREATE TABLE IF NOT EXISTS auction_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id UUID NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reaction_type VARCHAR(20) NOT NULL CHECK (reaction_type IN ('heart', 'thumbs_up', 'applause', 'fire')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Allow multiple reactions per user (unlike live streams which are unique)
  -- This allows users to send multiple reactions during an auction
  UNIQUE(auction_id, user_id, reaction_type, created_at)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_auction_reactions_auction_id ON auction_reactions(auction_id);
CREATE INDEX IF NOT EXISTS idx_auction_reactions_user_id ON auction_reactions(user_id);
CREATE INDEX IF NOT EXISTS idx_auction_reactions_created_at ON auction_reactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auction_reactions_type ON auction_reactions(reaction_type);

-- Enable Row Level Security
ALTER TABLE auction_reactions ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Anyone can view reactions (public engagement)
CREATE POLICY "Anyone can view auction reactions" ON auction_reactions
  FOR SELECT USING (true);

-- Authenticated users can send reactions
CREATE POLICY "Authenticated users can send reactions" ON auction_reactions
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can delete their own reactions (optional cleanup)
CREATE POLICY "Users can delete their own reactions" ON auction_reactions
  FOR DELETE USING (auth.uid() = user_id);

-- Grant permissions
GRANT SELECT, INSERT, DELETE ON auction_reactions TO authenticated;
GRANT ALL ON auction_reactions TO service_role;

-- Add comment
COMMENT ON TABLE auction_reactions IS 'Real-time reactions from viewers during live auctions (hearts, thumbs up, applause, fire)';

COMMIT;

