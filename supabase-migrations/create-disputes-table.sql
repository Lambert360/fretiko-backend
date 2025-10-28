-- =====================================================
-- DISPUTES TABLE
-- Handles order disputes and escrow dispute resolution
-- =====================================================

CREATE TABLE IF NOT EXISTS public.disputes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- Relationships
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  escrow_id UUID NOT NULL REFERENCES public.escrows(id) ON DELETE CASCADE,
  
  -- Participants
  disputant_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, -- User who initiated the dispute
  respondent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, -- The other party
  
  -- Dispute details
  dispute_type VARCHAR(50) NOT NULL CHECK (dispute_type IN (
    'item_not_received',
    'item_not_as_described',
    'damaged_item',
    'wrong_item',
    'refund_request',
    'quality_issue',
    'delivery_issue',
    'other'
  )),
  
  status VARCHAR(50) NOT NULL DEFAULT 'open' CHECK (status IN (
    'open',           -- Dispute filed, awaiting review
    'under_review',   -- Admin is reviewing
    'awaiting_info',  -- Awaiting additional information
    'resolved',       -- Resolved in favor of one party
    'cancelled'       -- Dispute withdrawn or cancelled
  )),
  
  -- Content
  reason TEXT NOT NULL,
  description TEXT,
  evidence JSONB DEFAULT '[]'::jsonb, -- Array of { type: 'image'|'document', url: string, description: string }
  
  -- Resolution
  resolution VARCHAR(50) CHECK (resolution IN (
    'refund_buyer',         -- Full refund to buyer
    'partial_refund',       -- Partial refund to buyer
    'release_to_vendor',    -- Release funds to vendor
    'split_amount',         -- Split escrow amount
    'no_action'             -- No action taken
  )),
  resolution_reason TEXT,
  resolution_amount DECIMAL(15, 2), -- Amount to refund/release
  resolved_by UUID REFERENCES auth.users(id), -- Admin who resolved
  resolved_at TIMESTAMP WITH TIME ZONE,
  
  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_disputes_order ON public.disputes(order_id);
CREATE INDEX IF NOT EXISTS idx_disputes_escrow ON public.disputes(escrow_id);
CREATE INDEX IF NOT EXISTS idx_disputes_disputant ON public.disputes(disputant_id);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON public.disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_created ON public.disputes(created_at DESC);

-- =====================================================
-- DISPUTE MESSAGES TABLE
-- For communication during dispute resolution
-- =====================================================

CREATE TABLE IF NOT EXISTS public.dispute_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dispute_id UUID NOT NULL REFERENCES public.disputes(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  is_admin_message BOOLEAN DEFAULT FALSE,
  attachments JSONB DEFAULT '[]'::jsonb, -- Array of { type: string, url: string }
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for message retrieval
CREATE INDEX IF NOT EXISTS idx_dispute_messages_dispute ON public.dispute_messages(dispute_id, created_at DESC);

-- =====================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- =====================================================

-- Enable RLS
ALTER TABLE public.disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispute_messages ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view disputes they are involved in
CREATE POLICY "Users can view their own disputes"
ON public.disputes FOR SELECT
TO authenticated
USING (
  disputant_id = auth.uid() OR 
  respondent_id = auth.uid()
);

-- Policy: Users can create disputes for their own orders
CREATE POLICY "Users can create disputes for their orders"
ON public.disputes FOR INSERT
TO authenticated
WITH CHECK (
  disputant_id = auth.uid() AND
  EXISTS (
    SELECT 1 FROM public.orders
    WHERE orders.id = order_id
    AND (orders.buyer_id = auth.uid() OR orders.vendor_id = auth.uid() OR orders.rider_id = auth.uid())
  )
);

-- Policy: Users can update their own open disputes (e.g., add evidence)
CREATE POLICY "Users can update their own open disputes"
ON public.disputes FOR UPDATE
TO authenticated
USING (
  disputant_id = auth.uid() AND 
  status = 'open'
)
WITH CHECK (
  disputant_id = auth.uid() AND 
  status IN ('open', 'awaiting_info')
);

-- Policy: Service role can manage all disputes (for admin actions)
CREATE POLICY "Service role can manage all disputes"
ON public.disputes FOR ALL
TO service_role
USING (true);

-- Policy: Users can view messages in their disputes
CREATE POLICY "Users can view messages in their disputes"
ON public.dispute_messages FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.disputes
    WHERE disputes.id = dispute_id
    AND (disputes.disputant_id = auth.uid() OR disputes.respondent_id = auth.uid())
  )
);

-- Policy: Users can send messages in their disputes
CREATE POLICY "Users can send messages in their disputes"
ON public.dispute_messages FOR INSERT
TO authenticated
WITH CHECK (
  sender_id = auth.uid() AND
  EXISTS (
    SELECT 1 FROM public.disputes
    WHERE disputes.id = dispute_id
    AND (disputes.disputant_id = auth.uid() OR disputes.respondent_id = auth.uid())
  )
);

-- Policy: Service role can manage all dispute messages
CREATE POLICY "Service role can manage all dispute messages"
ON public.dispute_messages FOR ALL
TO service_role
USING (true);

-- =====================================================
-- TRIGGERS
-- =====================================================

-- Update disputes.updated_at on row update
CREATE OR REPLACE FUNCTION update_disputes_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_disputes_updated_at
BEFORE UPDATE ON public.disputes
FOR EACH ROW
EXECUTE FUNCTION update_disputes_updated_at();

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON TABLE public.disputes IS 'Stores order disputes and escrow dispute resolution';
COMMENT ON TABLE public.dispute_messages IS 'Communication thread for dispute resolution';
COMMENT ON COLUMN public.disputes.evidence IS 'JSON array of evidence (images, documents)';
COMMENT ON COLUMN public.disputes.resolution IS 'Final resolution decision by admin';

