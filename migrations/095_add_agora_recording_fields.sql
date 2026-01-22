-- Migration: Add Agora Cloud Recording fields to live_streams
-- Date: 2026-01-19
-- Description: Add fields to track Agora Cloud Recording resourceId and sid for HLS recording management

-- Add columns for Agora Cloud Recording tracking
ALTER TABLE live_streams
ADD COLUMN IF NOT EXISTS agora_resource_id TEXT,
ADD COLUMN IF NOT EXISTS agora_sid TEXT;

-- Add comment for documentation
COMMENT ON COLUMN live_streams.agora_resource_id IS 'Agora Cloud Recording resource ID for managing recording sessions';
COMMENT ON COLUMN live_streams.agora_sid IS 'Agora Cloud Recording session ID (sid) for the current recording';

-- Create index for faster lookups when stopping recordings
CREATE INDEX IF NOT EXISTS idx_live_streams_agora_resource_id 
ON live_streams(agora_resource_id) 
WHERE agora_resource_id IS NOT NULL;

