-- Migration: Add 'escalated' status to disputes table
-- Description: Allow disputes to be escalated to higher authority

-- Drop existing status constraint
ALTER TABLE public.disputes 
DROP CONSTRAINT IF EXISTS disputes_status_check;

-- Add new constraint with 'escalated' status
ALTER TABLE public.disputes 
ADD CONSTRAINT disputes_status_check 
CHECK (status IN (
  'open',           -- Dispute filed, awaiting review
  'under_review',   -- Admin is reviewing
  'awaiting_info',  -- Awaiting additional information
  'resolved',       -- Resolved in favor of one party
  'escalated',      -- Escalated to higher authority
  'cancelled'       -- Dispute withdrawn or cancelled
));

-- Add comment
COMMENT ON COLUMN public.disputes.status IS 'Dispute status: open, under_review, awaiting_info, resolved, escalated, cancelled';

