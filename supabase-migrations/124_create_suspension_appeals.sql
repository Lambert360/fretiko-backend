-- =====================================================
-- CREATE SUSPENSION APPEALS TABLE
-- =====================================================
-- This migration creates a table for users to appeal their account suspensions

CREATE TABLE IF NOT EXISTS public.suspension_appeals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    suspension_reason TEXT, -- Original suspension reason
    appeal_reason TEXT NOT NULL, -- User's reason for appeal
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'under_review', 'approved', 'rejected')),
    reviewed_by UUID REFERENCES public.staff_accounts(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    review_notes TEXT, -- Admin's review notes
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_suspension_appeals_user_id ON public.suspension_appeals(user_id);
CREATE INDEX IF NOT EXISTS idx_suspension_appeals_status ON public.suspension_appeals(status);
CREATE INDEX IF NOT EXISTS idx_suspension_appeals_created_at ON public.suspension_appeals(created_at DESC);

-- Create updated_at trigger
CREATE TRIGGER suspension_appeals_updated_at
    BEFORE UPDATE ON public.suspension_appeals
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- Enable RLS
ALTER TABLE public.suspension_appeals ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Users can view their own appeals
CREATE POLICY "Users can view own appeals" ON public.suspension_appeals
    FOR SELECT USING (auth.uid() = user_id);

-- Users can create appeals for their own account
CREATE POLICY "Users can create own appeals" ON public.suspension_appeals
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Staff can view all appeals
CREATE POLICY "Staff can view all appeals" ON public.suspension_appeals
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE id = auth.uid()::text::uuid
            AND is_active = true
            AND deleted_at IS NULL
        )
    );

-- Staff can update appeals (for review)
CREATE POLICY "Staff can update appeals" ON public.suspension_appeals
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE id = auth.uid()::text::uuid
            AND is_active = true
            AND deleted_at IS NULL
        )
    );

COMMENT ON TABLE public.suspension_appeals IS 'Appeals submitted by users for account suspensions';
COMMENT ON COLUMN public.suspension_appeals.status IS 'Appeal status: pending, under_review, approved, rejected';
COMMENT ON COLUMN public.suspension_appeals.appeal_reason IS 'User-provided reason for why they believe the suspension should be lifted';

