-- Migration: Create user_warnings table
-- Description: Track user warnings issued by staff for violations
-- Date: 2025-12-14

-- ================================
-- USER WARNINGS TABLE
-- ================================

CREATE TABLE IF NOT EXISTS public.user_warnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
    warned_by UUID NOT NULL REFERENCES public.staff_accounts(id) ON DELETE SET NULL,
    severity VARCHAR(10) NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
    reason TEXT NOT NULL,
    related_content_id UUID, -- Can reference products, services, chats, or users
    related_content_type VARCHAR(20) CHECK (related_content_type IN ('product', 'service', 'chat', 'user')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================
-- INDEXES
-- ================================

CREATE INDEX IF NOT EXISTS idx_user_warnings_user_id ON public.user_warnings(user_id);
CREATE INDEX IF NOT EXISTS idx_user_warnings_created_at ON public.user_warnings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_warnings_warned_by ON public.user_warnings(warned_by);
CREATE INDEX IF NOT EXISTS idx_user_warnings_severity ON public.user_warnings(severity);

-- ================================
-- ROW LEVEL SECURITY (RLS)
-- ================================

ALTER TABLE public.user_warnings ENABLE ROW LEVEL SECURITY;

-- Users can view their own warnings
CREATE POLICY "Users can view their own warnings" ON public.user_warnings
FOR SELECT USING (auth.uid() = user_id);

-- Staff can view all warnings (handled via service role in backend)
-- No INSERT/UPDATE/DELETE policies for users - only staff via backend

-- ================================
-- COMMENTS
-- ================================

COMMENT ON TABLE public.user_warnings IS 'Tracks warnings issued to users by staff members';
COMMENT ON COLUMN public.user_warnings.severity IS 'Warning severity: low, medium, or high';
COMMENT ON COLUMN public.user_warnings.reason IS 'Reason for the warning';
COMMENT ON COLUMN public.user_warnings.related_content_id IS 'ID of related content (product, service, chat, or user) that triggered the warning';
COMMENT ON COLUMN public.user_warnings.related_content_type IS 'Type of related content: product, service, chat, or user';

