-- Migration: Add staff_id to dispute_messages table
-- Description: Allow staff members to send messages in disputes by adding staff_id column
-- This enables customer care staff to communicate with users through dispute threads

-- Make sender_id nullable to allow staff messages (staff don't have user_profiles)
ALTER TABLE public.dispute_messages
ALTER COLUMN sender_id DROP NOT NULL;

-- Add staff_id column for staff messages
ALTER TABLE public.dispute_messages
ADD COLUMN IF NOT EXISTS staff_id UUID REFERENCES public.staff_accounts(id) ON DELETE SET NULL;

-- Update is_admin column name to match queries (if it's named differently)
-- Check if column exists as is_admin_message, if so, we'll use that
-- Otherwise, the is_admin column should work

-- Add index for staff_id
CREATE INDEX IF NOT EXISTS idx_dispute_messages_staff_id ON public.dispute_messages(staff_id);

-- Add constraint: Either sender_id or staff_id must be set
ALTER TABLE public.dispute_messages
ADD CONSTRAINT dispute_messages_sender_check 
CHECK (
  (sender_id IS NOT NULL AND staff_id IS NULL) OR 
  (sender_id IS NULL AND staff_id IS NOT NULL)
);

-- Update RLS policies to allow staff to insert messages
-- Staff can insert messages via service role, so this is mainly for documentation
COMMENT ON COLUMN public.dispute_messages.staff_id IS 'ID of staff member who sent this message (for admin/customer care messages)';
COMMENT ON COLUMN public.dispute_messages.sender_id IS 'ID of user who sent this message (nullable for staff messages)';
COMMENT ON COLUMN public.dispute_messages.is_admin IS 'True if message is from platform admin/support staff';

