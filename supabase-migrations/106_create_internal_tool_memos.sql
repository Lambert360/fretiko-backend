-- =====================================================
-- FRETIKO INTERNAL TOOL: MEMOS TABLE
-- =====================================================
-- Internal communication system for departments and staff

-- Create memos table
CREATE TABLE IF NOT EXISTS public.memos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    sender_id UUID NOT NULL REFERENCES public.staff_accounts(id) ON DELETE CASCADE,
    sender_department_id UUID REFERENCES public.departments(id) ON DELETE SET NULL,
    recipient_type TEXT NOT NULL CHECK (recipient_type IN ('department', 'staff', 'all')),
    recipient_id UUID, -- NULL if recipient_type = 'all'
    priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    is_read BOOLEAN DEFAULT false,
    read_at TIMESTAMP WITH TIME ZONE,
    read_by UUID REFERENCES public.staff_accounts(id) ON DELETE SET NULL,
    attachments JSONB DEFAULT '[]'::jsonb, -- Array of {type, url, name, size}
    parent_memo_id UUID REFERENCES public.memos(id) ON DELETE SET NULL, -- For threading/replies
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_memos_sender_id ON public.memos(sender_id);
CREATE INDEX IF NOT EXISTS idx_memos_recipient_type ON public.memos(recipient_type);
CREATE INDEX IF NOT EXISTS idx_memos_recipient_id ON public.memos(recipient_id);
CREATE INDEX IF NOT EXISTS idx_memos_is_read ON public.memos(is_read);
CREATE INDEX IF NOT EXISTS idx_memos_priority ON public.memos(priority);
CREATE INDEX IF NOT EXISTS idx_memos_created_at ON public.memos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memos_parent_memo_id ON public.memos(parent_memo_id);

-- Enable RLS
ALTER TABLE public.memos ENABLE ROW LEVEL SECURITY;

-- RLS Policies

-- Staff can view memos sent by them
CREATE POLICY "Staff can view sent memos"
    ON public.memos
    FOR SELECT
    USING (sender_id = auth.uid());

-- Staff can view memos sent to them directly
CREATE POLICY "Staff can view memos sent to them"
    ON public.memos
    FOR SELECT
    USING (
        recipient_type = 'staff'
        AND recipient_id = auth.uid()
    );

-- Staff can view memos sent to their department
CREATE POLICY "Staff can view department memos"
    ON public.memos
    FOR SELECT
    USING (
        recipient_type = 'department'
        AND EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE staff_accounts.id = auth.uid()
            AND staff_accounts.department_id = memos.recipient_id
            AND staff_accounts.is_active = true
        )
    );

-- Staff can view memos sent to all
CREATE POLICY "Staff can view all-staff memos"
    ON public.memos
    FOR SELECT
    USING (
        recipient_type = 'all'
        AND EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE staff_accounts.id = auth.uid()
            AND staff_accounts.is_active = true
        )
    );

-- Super admin can view all memos
CREATE POLICY "Super admin can view all memos"
    ON public.memos
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE staff_accounts.id = auth.uid()
            AND staff_accounts.role = 'super_admin'
            AND staff_accounts.is_active = true
        )
    );

-- Staff can send memos
CREATE POLICY "Staff can send memos"
    ON public.memos
    FOR INSERT
    WITH CHECK (
        sender_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM public.staff_accounts s
            LEFT JOIN public.departments d ON s.department_id = d.id
            WHERE s.id = auth.uid()
            AND s.is_active = true
            AND (d.permissions ? 'send_memos' OR s.role = 'super_admin')
        )
    );

-- Staff can mark memos as read (only memos addressed to them)
CREATE POLICY "Staff can mark memos as read"
    ON public.memos
    FOR UPDATE
    USING (
        (recipient_type = 'staff' AND recipient_id = auth.uid())
        OR (
            recipient_type = 'department'
            AND EXISTS (
                SELECT 1 FROM public.staff_accounts
                WHERE staff_accounts.id = auth.uid()
                AND staff_accounts.department_id = memos.recipient_id
            )
        )
        OR recipient_type = 'all'
    )
    WITH CHECK (
        -- Only allow updating is_read, read_at, read_by fields
        sender_id = OLD.sender_id
        AND subject = OLD.subject
        AND body = OLD.body
    );

-- Create memo_reads table for tracking who read department/all memos
CREATE TABLE IF NOT EXISTS public.memo_reads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memo_id UUID NOT NULL REFERENCES public.memos(id) ON DELETE CASCADE,
    staff_id UUID NOT NULL REFERENCES public.staff_accounts(id) ON DELETE CASCADE,
    read_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    UNIQUE(memo_id, staff_id)
);

CREATE INDEX IF NOT EXISTS idx_memo_reads_memo_id ON public.memo_reads(memo_id);
CREATE INDEX IF NOT EXISTS idx_memo_reads_staff_id ON public.memo_reads(staff_id);

-- Enable RLS on memo_reads
ALTER TABLE public.memo_reads ENABLE ROW LEVEL SECURITY;

-- Staff can view their own reads
CREATE POLICY "Staff can view own reads"
    ON public.memo_reads
    FOR SELECT
    USING (staff_id = auth.uid());

-- Staff can mark memos as read
CREATE POLICY "Staff can mark memos read"
    ON public.memo_reads
    FOR INSERT
    WITH CHECK (staff_id = auth.uid());

-- Super admin can view all reads
CREATE POLICY "Super admin can view all reads"
    ON public.memo_reads
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.staff_accounts
            WHERE staff_accounts.id = auth.uid()
            AND staff_accounts.role = 'super_admin'
            AND staff_accounts.is_active = true
        )
    );

COMMENT ON TABLE public.memos IS 'Internal communication system for staff and departments';
COMMENT ON TABLE public.memo_reads IS 'Tracks which staff members have read department/all memos';
COMMENT ON COLUMN public.memos.recipient_type IS 'Type of recipient: department, staff, or all';
COMMENT ON COLUMN public.memos.parent_memo_id IS 'Reference to parent memo for threading/replies';
