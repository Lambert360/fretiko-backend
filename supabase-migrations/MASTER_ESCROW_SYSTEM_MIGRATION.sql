-- ============================================
-- MASTER MIGRATION: FRETI ESCROW & ORDER SYSTEM
-- ============================================
-- This migration includes all changes needed for the complete escrow system:
-- 1. Service bookings order_id column
-- 2. Escrow RLS policies
-- 3. Disputes table
-- 4. Dispute messages table
-- 5. Dispute RLS policies
--
-- Run this file ONCE in Supabase SQL Editor
-- ============================================

-- ============================================
-- PART 1: SERVICE BOOKINGS - LINK TO ORDERS
-- ============================================

-- Add order_id column to service_bookings table to link bookings to orders/escrow
ALTER TABLE public.service_bookings 
ADD COLUMN IF NOT EXISTS order_id UUID;

-- Add foreign key constraint to orders table
ALTER TABLE public.service_bookings
ADD CONSTRAINT service_bookings_order_id_fkey 
FOREIGN KEY (order_id) 
REFERENCES public.orders(id) 
ON DELETE CASCADE;

-- Create index for faster order lookups
CREATE INDEX IF NOT EXISTS idx_service_bookings_order_id 
ON public.service_bookings(order_id);

-- Add comment for documentation
COMMENT ON COLUMN public.service_bookings.order_id IS 'Links service booking to unified order system for escrow and tracking';

-- ============================================
-- PART 2: ESCROW RLS POLICIES
-- ============================================

-- Enable RLS for the escrows table
ALTER TABLE public.escrows ENABLE ROW LEVEL SECURITY;

-- Policy to allow authenticated users to view escrows where they are the buyer, vendor, or rider of the associated order
CREATE POLICY "Authenticated users can view their related escrows"
ON public.escrows FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.orders
    WHERE
      orders.id = escrows.order_id AND (
        orders.buyer_id = auth.uid() OR
        orders.vendor_id = auth.uid() OR
        orders.rider_id = auth.uid()
      )
  )
);

-- Policy to allow service role to insert escrows (e.g., from backend service)
CREATE POLICY "Service role can insert escrows"
ON public.escrows FOR INSERT
TO service_role
WITH CHECK (true);

-- Policy to allow service role to update escrows (e.g., for status changes, auto-release)
CREATE POLICY "Service role can update escrows"
ON public.escrows FOR UPDATE
TO service_role
USING (true);

-- ============================================
-- PART 3: DISPUTES TABLE
-- ============================================

-- Create disputes table
CREATE TABLE IF NOT EXISTS public.disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  complainant_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  respondent_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  dispute_type VARCHAR(50) NOT NULL CHECK (dispute_type IN (
    'item_not_received',
    'item_not_as_described',
    'damaged_item',
    'wrong_item',
    'service_not_completed',
    'poor_quality',
    'late_delivery',
    'other'
  )),
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN (
    'open',
    'under_review',
    'resolved',
    'closed'
  )),
  reason TEXT NOT NULL,
  evidence JSONB DEFAULT '[]'::jsonb, -- Array of evidence (images, documents, etc.)
  resolution VARCHAR(50) CHECK (resolution IN (
    'refund_buyer',
    'release_to_vendor',
    'partial_refund',
    'no_action',
    null
  )),
  resolution_notes TEXT,
  admin_notes TEXT,
  resolved_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_disputes_order_id ON public.disputes(order_id);
CREATE INDEX IF NOT EXISTS idx_disputes_complainant_id ON public.disputes(complainant_id);
CREATE INDEX IF NOT EXISTS idx_disputes_respondent_id ON public.disputes(respondent_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON public.disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_created_at ON public.disputes(created_at DESC);

-- Add comments
COMMENT ON TABLE public.disputes IS 'Order disputes filed by buyers or vendors';
COMMENT ON COLUMN public.disputes.evidence IS 'JSON array of evidence URLs (images, documents, videos)';
COMMENT ON COLUMN public.disputes.resolution IS 'Admin decision on how to resolve the dispute';

-- ============================================
-- PART 4: DISPUTE MESSAGES TABLE
-- ============================================

-- Create dispute_messages table for communication between parties
CREATE TABLE IF NOT EXISTS public.dispute_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES public.disputes(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  attachments JSONB DEFAULT '[]'::jsonb, -- Array of attachment URLs
  is_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_dispute_messages_dispute_id ON public.dispute_messages(dispute_id);
CREATE INDEX IF NOT EXISTS idx_dispute_messages_sender_id ON public.dispute_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_dispute_messages_created_at ON public.dispute_messages(created_at DESC);

-- Add comments
COMMENT ON TABLE public.dispute_messages IS 'Messages exchanged during dispute resolution process';
COMMENT ON COLUMN public.dispute_messages.attachments IS 'JSON array of file URLs attached to message';
COMMENT ON COLUMN public.dispute_messages.is_admin IS 'True if message is from platform admin/support';

-- ============================================
-- PART 5: DISPUTE RLS POLICIES
-- ============================================

-- Enable RLS on disputes table
ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view disputes where they are involved (complainant or respondent)
CREATE POLICY "Users can view disputes they are involved in"
ON public.disputes FOR SELECT
TO authenticated
USING (
  complainant_id = auth.uid() OR 
  respondent_id = auth.uid()
);

-- Policy: Authenticated users can create disputes
CREATE POLICY "Authenticated users can create disputes"
ON public.disputes FOR INSERT
TO authenticated
WITH CHECK (complainant_id = auth.uid());

-- Policy: Service role can update any dispute (for admin actions)
CREATE POLICY "Service role can update disputes"
ON public.disputes FOR UPDATE
TO service_role
USING (true);

-- Enable RLS on dispute_messages table
ALTER TABLE public.dispute_messages ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view messages in disputes they're involved in
CREATE POLICY "Users can view messages in their disputes"
ON public.dispute_messages FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.disputes
    WHERE 
      disputes.id = dispute_messages.dispute_id AND (
        disputes.complainant_id = auth.uid() OR 
        disputes.respondent_id = auth.uid()
      )
  )
);

-- Policy: Users can send messages in disputes they're involved in
CREATE POLICY "Users can send messages in their disputes"
ON public.dispute_messages FOR INSERT
TO authenticated
WITH CHECK (
  sender_id = auth.uid() AND
  EXISTS (
    SELECT 1
    FROM public.disputes
    WHERE 
      disputes.id = dispute_messages.dispute_id AND (
        disputes.complainant_id = auth.uid() OR 
        disputes.respondent_id = auth.uid()
      )
  )
);

-- Policy: Service role can insert admin messages
CREATE POLICY "Service role can insert admin messages"
ON public.dispute_messages FOR INSERT
TO service_role
WITH CHECK (is_admin = true);

-- ============================================
-- PART 6: UPDATED_AT TRIGGERS
-- ============================================

-- Create trigger function for updated_at if it doesn't exist
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add trigger to disputes table
DROP TRIGGER IF EXISTS update_disputes_updated_at ON public.disputes;
CREATE TRIGGER update_disputes_updated_at
  BEFORE UPDATE ON public.disputes
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================
-- VERIFICATION QUERIES
-- ============================================

-- Run these queries after migration to verify success:
-- 
-- 1. Check service_bookings column:
--    SELECT column_name, data_type FROM information_schema.columns 
--    WHERE table_name = 'service_bookings' AND column_name = 'order_id';
--
-- 2. Check escrow policies:
--    SELECT * FROM pg_policies WHERE tablename = 'escrows';
--
-- 3. Check disputes table exists:
--    SELECT * FROM information_schema.tables WHERE table_name = 'disputes';
--
-- 4. Check dispute_messages table exists:
--    SELECT * FROM information_schema.tables WHERE table_name = 'dispute_messages';
--
-- 5. Check dispute policies:
--    SELECT * FROM pg_policies WHERE tablename IN ('disputes', 'dispute_messages');

-- ============================================
-- MIGRATION COMPLETE
-- ============================================
-- All tables, columns, indexes, and RLS policies have been created.
-- The escrow system is now fully configured.
-- 
-- Next steps:
-- 1. Verify migration success using queries above
-- 2. Restart backend service
-- 3. Run test suite
-- 4. Deploy to production
-- ============================================

