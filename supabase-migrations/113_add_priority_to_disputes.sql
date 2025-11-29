-- =====================================================
-- ADD PRIORITY COLUMN TO DISPUTES TABLE
-- Adds a priority field to help staff prioritize dispute resolution
-- =====================================================

-- Add priority column to disputes table
ALTER TABLE public.disputes 
ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('urgent', 'high', 'medium', 'low'));

-- Add comment explaining the column
COMMENT ON COLUMN public.disputes.priority IS 'Priority level for dispute resolution: urgent (immediate attention), high (within 24h), medium (within 48h), low (within 7 days)';

-- Set default priority for existing disputes
UPDATE public.disputes 
SET priority = 'medium' 
WHERE priority IS NULL;

-- Create index for faster priority-based queries
CREATE INDEX IF NOT EXISTS idx_disputes_priority ON public.disputes(priority);

