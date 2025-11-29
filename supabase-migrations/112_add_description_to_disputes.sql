-- =====================================================
-- ADD DESCRIPTION COLUMN TO DISPUTES TABLE
-- Adds a description field for additional context beyond reason
-- =====================================================

-- Add description column to disputes table
ALTER TABLE public.disputes 
ADD COLUMN IF NOT EXISTS description TEXT;

-- Add comment explaining the column
COMMENT ON COLUMN public.disputes.description IS 'Detailed description of the dispute providing additional context beyond the reason field';

-- Update existing disputes to use reason as description if description is null
UPDATE public.disputes 
SET description = reason 
WHERE description IS NULL;

