-- =====================================================
-- SEPARATE DISPUTES FROM CONTENT REPORTS
-- Disputes: Customer care (order_dispute, bug_report, general)
-- Content Reports: Moderation (product, service, chat, user reports)
-- =====================================================

-- PART 1: UPDATE DISPUTES TABLE (Customer Care Only)
-- =====================================================

-- Make order_id, escrow_id, and respondent_id optional (for bug reports and general support)
-- Check if columns exist before altering them
DO $$
BEGIN
  -- Make order_id optional if it exists
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'disputes' 
    AND column_name = 'order_id'
  ) THEN
    ALTER TABLE public.disputes ALTER COLUMN order_id DROP NOT NULL;
  END IF;

  -- Make escrow_id optional if it exists
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'disputes' 
    AND column_name = 'escrow_id'
  ) THEN
    ALTER TABLE public.disputes ALTER COLUMN escrow_id DROP NOT NULL;
  END IF;

  -- Make respondent_id optional if it exists
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'disputes' 
    AND column_name = 'respondent_id'
  ) THEN
    ALTER TABLE public.disputes ALTER COLUMN respondent_id DROP NOT NULL;
  END IF;
END $$;

-- Add dispute category field (only customer care types)
-- First add column without constraint, then set default for existing rows, then add constraint
ALTER TABLE public.disputes 
  ADD COLUMN IF NOT EXISTS dispute_category VARCHAR(50);

-- Set default value for existing disputes (assume they are order disputes)
UPDATE public.disputes 
SET dispute_category = 'order_dispute' 
WHERE dispute_category IS NULL;

-- Now add the constraint
ALTER TABLE public.disputes 
  ALTER COLUMN dispute_category SET DEFAULT 'order_dispute',
  ALTER COLUMN dispute_category SET NOT NULL;

ALTER TABLE public.disputes 
  ADD CONSTRAINT disputes_dispute_category_check 
  CHECK (dispute_category IN (
    'order_dispute',    -- Order-related disputes (customer care)
    'bug_report',       -- Bug/technical issue reports (customer care)
    'general'           -- General support requests (customer care)
  ));

-- Update dispute_type to only include customer care types
-- First, check if there are any disputes with invalid dispute_types and update them to 'other'
UPDATE public.disputes 
SET dispute_type = 'other'
WHERE dispute_type NOT IN (
  -- Order dispute types
  'item_not_received',
  'item_not_as_described',
  'damaged_item',
  'wrong_item',
  'refund_request',
  'quality_issue',
  'delivery_issue',
  -- Bug report types
  'app_crash',
  'payment_issue',
  'login_issue',
  'feature_not_working',
  'performance_issue',
  -- General
  'other'
);

-- Now drop and recreate the constraint
ALTER TABLE public.disputes 
  DROP CONSTRAINT IF EXISTS disputes_dispute_type_check;

ALTER TABLE public.disputes 
  ADD CONSTRAINT disputes_dispute_type_check 
  CHECK (dispute_type IN (
    -- Order dispute types
    'item_not_received',
    'item_not_as_described',
    'damaged_item',
    'wrong_item',
    'refund_request',
    'quality_issue',
    'delivery_issue',
    -- Bug report types
    'app_crash',
    'payment_issue',
    'login_issue',
    'feature_not_working',
    'performance_issue',
    -- General
    'other'
  ));

-- Update indexes
CREATE INDEX IF NOT EXISTS idx_disputes_category ON public.disputes(dispute_category);

-- Update RLS policies for disputes (customer care only)
-- First, check if we need to rename complainant_id to disputant_id for consistency
DO $$
BEGIN
  -- If complainant_id exists but disputant_id doesn't, rename it
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'disputes' 
    AND column_name = 'complainant_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'disputes' 
    AND column_name = 'disputant_id'
  ) THEN
    -- Rename the column
    ALTER TABLE public.disputes RENAME COLUMN complainant_id TO disputant_id;
    
    -- Update indexes that reference the old column name
    DROP INDEX IF EXISTS idx_disputes_complainant_id;
    CREATE INDEX IF NOT EXISTS idx_disputes_disputant ON public.disputes(disputant_id);
  END IF;
END $$;

-- Drop old policies
DROP POLICY IF EXISTS "Users can create disputes for their orders" ON public.disputes;
DROP POLICY IF EXISTS "Authenticated users can create disputes" ON public.disputes;
DROP POLICY IF EXISTS "Users can view their own disputes" ON public.disputes;
DROP POLICY IF EXISTS "Users can view disputes they are involved in" ON public.disputes;

-- Create new policy for creating disputes (checking which column exists)
DO $$
BEGIN
  -- Check if disputant_id exists (after potential rename)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'disputes' 
    AND column_name = 'disputant_id'
  ) THEN
    EXECUTE '
      CREATE POLICY "Users can create disputes"
      ON public.disputes FOR INSERT
      TO authenticated
      WITH CHECK (
        disputant_id = auth.uid() AND
        (
          -- Order disputes: must be involved in the order
          (dispute_category = ''order_dispute'' AND order_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.orders
            WHERE orders.id = order_id
            AND (orders.buyer_id = auth.uid() OR orders.vendor_id = auth.uid() OR orders.rider_id = auth.uid())
          ))
          OR
          -- Bug reports: anyone can report
          (dispute_category = ''bug_report'')
          OR
          -- General: anyone can create
          (dispute_category = ''general'')
        )
      )';
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'disputes' 
    AND column_name = 'complainant_id'
  ) THEN
    EXECUTE '
      CREATE POLICY "Users can create disputes"
      ON public.disputes FOR INSERT
      TO authenticated
      WITH CHECK (
        complainant_id = auth.uid() AND
        (
          -- Order disputes: must be involved in the order
          (dispute_category = ''order_dispute'' AND order_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.orders
            WHERE orders.id = order_id
            AND (orders.buyer_id = auth.uid() OR orders.vendor_id = auth.uid() OR orders.rider_id = auth.uid())
          ))
          OR
          -- Bug reports: anyone can report
          (dispute_category = ''bug_report'')
          OR
          -- General: anyone can create
          (dispute_category = ''general'')
        )
      )';
  END IF;
END $$;

-- Create view policy (checking which column exists)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'disputes' 
    AND column_name = 'disputant_id'
  ) THEN
    EXECUTE '
      CREATE POLICY "Users can view their own disputes"
      ON public.disputes FOR SELECT
      TO authenticated
      USING (
        disputant_id = auth.uid() OR 
        respondent_id = auth.uid() OR
        EXISTS (
          SELECT 1 FROM public.user_profiles
          WHERE id = auth.uid()
          AND (preferences->>''isAdmin'' = ''true'' OR preferences->>''isModerator'' = ''true'')
        )
      )';
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'disputes' 
    AND column_name = 'complainant_id'
  ) THEN
    EXECUTE '
      CREATE POLICY "Users can view their own disputes"
      ON public.disputes FOR SELECT
      TO authenticated
      USING (
        complainant_id = auth.uid() OR 
        respondent_id = auth.uid() OR
        EXISTS (
          SELECT 1 FROM public.user_profiles
          WHERE id = auth.uid()
          AND (preferences->>''isAdmin'' = ''true'' OR preferences->>''isModerator'' = ''true'')
        )
      )';
  END IF;
END $$;

-- Update comments
COMMENT ON COLUMN public.disputes.dispute_category IS 'Category of dispute: order_dispute (customer care), bug_report (customer care), general (customer care)';

-- PART 2: CREATE CONTENT REPORTS TABLE (Moderation)
-- =====================================================

CREATE TABLE IF NOT EXISTS public.content_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- Reporter
  reporter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- Report category
  report_category VARCHAR(50) NOT NULL CHECK (report_category IN (
    'product',      -- Report a product listing
    'service',      -- Report a service listing
    'chat',         -- Report inappropriate chat
    'user'          -- Report a user account
  )),
  
  -- Reference to reported content (one of these will be set)
  product_id UUID REFERENCES public.products(id) ON DELETE CASCADE,
  service_id UUID REFERENCES public.services(id) ON DELETE CASCADE,
  chat_id UUID REFERENCES public.chat_conversations(id) ON DELETE CASCADE,
  reported_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- Report details
  report_type VARCHAR(50) NOT NULL CHECK (report_type IN (
    -- Product/Service report types
    'inappropriate_content',
    'spam',
    'fraudulent_listing',
    'copyright_violation',
    'misleading_information',
    -- Chat report types
    'harassment',
    'spam_messages',
    'inappropriate_language',
    'threats',
    -- User report types
    'suspicious_activity',
    'fake_account',
    'scam_attempt',
    -- General
    'other'
  )),
  
  -- Status
  status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending',        -- Awaiting moderator review
    'under_review',   -- Moderator is reviewing
    'approved',       -- Content is appropriate, report dismissed
    'action_taken',   -- Content removed/warned/banned
    'dismissed'       -- Report dismissed without action
  )),
  
  -- Content
  reason TEXT NOT NULL,
  description TEXT,
  evidence JSONB DEFAULT '[]'::jsonb, -- Array of { type: 'image'|'document', url: string, description: string }
  
  -- Moderation action
  action_taken VARCHAR(50) CHECK (action_taken IN (
    'no_action',           -- No action needed
    'content_removed',     -- Content removed
    'content_hidden',      -- Content hidden from public
    'user_warned',         -- User received warning
    'user_suspended',      -- User account suspended
    'user_banned'          -- User account banned
  )),
  action_reason TEXT,
  moderated_by UUID REFERENCES auth.users(id), -- Moderator who took action
  moderated_at TIMESTAMP WITH TIME ZONE,
  
  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_content_reports_reporter ON public.content_reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_content_reports_category ON public.content_reports(report_category);
CREATE INDEX IF NOT EXISTS idx_content_reports_status ON public.content_reports(status);
CREATE INDEX IF NOT EXISTS idx_content_reports_product ON public.content_reports(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_content_reports_service ON public.content_reports(service_id) WHERE service_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_content_reports_chat ON public.content_reports(chat_id) WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_content_reports_user ON public.content_reports(reported_user_id) WHERE reported_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_content_reports_created ON public.content_reports(created_at DESC);

-- CONTENT REPORT MESSAGES TABLE
CREATE TABLE IF NOT EXISTS public.content_report_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_id UUID NOT NULL REFERENCES public.content_reports(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  is_moderator_message BOOLEAN DEFAULT FALSE,
  attachments JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_report_messages_report ON public.content_report_messages(report_id, created_at DESC);

-- ROW LEVEL SECURITY (RLS) POLICIES FOR CONTENT REPORTS
ALTER TABLE public.content_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_report_messages ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own reports
CREATE POLICY "Users can view their own content reports"
ON public.content_reports FOR SELECT
TO authenticated
USING (
  reporter_id = auth.uid() OR
  -- Moderators can view all reports
        EXISTS (
          SELECT 1 FROM public.user_profiles
          WHERE id = auth.uid()
          AND (preferences->>'isAdmin' = 'true' OR preferences->>'isModerator' = 'true')
        )
);

-- Policy: Users can create content reports
CREATE POLICY "Users can create content reports"
ON public.content_reports FOR INSERT
TO authenticated
WITH CHECK (
  reporter_id = auth.uid() AND
  (
    -- Product report: must reference valid product
    (report_category = 'product' AND product_id IS NOT NULL)
    OR
    -- Service report: must reference valid service
    (report_category = 'service' AND service_id IS NOT NULL)
    OR
    -- Chat report: must be participant in chat
    (report_category = 'chat' AND chat_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.chat_participants
      WHERE conversation_id = chat_id
      AND user_id = auth.uid()
    ))
    OR
    -- User report: cannot report yourself
    (report_category = 'user' AND reported_user_id IS NOT NULL AND reported_user_id != auth.uid())
  )
);

-- Policy: Users can update their own pending reports
CREATE POLICY "Users can update their own pending reports"
ON public.content_reports FOR UPDATE
TO authenticated
USING (
  reporter_id = auth.uid() AND 
  status = 'pending'
)
WITH CHECK (
  reporter_id = auth.uid() AND 
  status = 'pending'
);

-- Policy: Service role can manage all reports (for moderators)
CREATE POLICY "Service role can manage all content reports"
ON public.content_reports FOR ALL
TO service_role
USING (true);

-- Policy: Users can view messages in their reports
CREATE POLICY "Users can view messages in their content reports"
ON public.content_report_messages FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE content_reports.id = report_id
    AND (
      content_reports.reporter_id = auth.uid()
      OR
        EXISTS (
          SELECT 1 FROM public.user_profiles
          WHERE id = auth.uid()
          AND (preferences->>'isAdmin' = 'true' OR preferences->>'isModerator' = 'true')
        )
    )
  )
);

-- Policy: Users can send messages in their reports
CREATE POLICY "Users can send messages in their content reports"
ON public.content_report_messages FOR INSERT
TO authenticated
WITH CHECK (
  sender_id = auth.uid() AND
  EXISTS (
    SELECT 1 FROM public.content_reports
    WHERE content_reports.id = report_id
    AND content_reports.reporter_id = auth.uid()
  )
);

-- Policy: Service role can manage all report messages
CREATE POLICY "Service role can manage all content report messages"
ON public.content_report_messages FOR ALL
TO service_role
USING (true);

-- TRIGGERS
CREATE OR REPLACE FUNCTION update_content_reports_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_content_reports_updated_at
BEFORE UPDATE ON public.content_reports
FOR EACH ROW
EXECUTE FUNCTION update_content_reports_updated_at();

-- COMMENTS
COMMENT ON TABLE public.content_reports IS 'User reports of inappropriate content for moderation';
COMMENT ON TABLE public.content_report_messages IS 'Communication thread for content report moderation';
COMMENT ON COLUMN public.content_reports.evidence IS 'JSON array of evidence (images, documents)';
COMMENT ON COLUMN public.content_reports.action_taken IS 'Moderation action taken by moderator';

