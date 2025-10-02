-- Migration: Add RLS Policies for Chat Invoices
-- Date: 2025-10-01
-- Description: Row Level Security policies for invoice tables

BEGIN;

-- Enable RLS on invoice tables
ALTER TABLE chat_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_invoice_items ENABLE ROW LEVEL SECURITY;

-- ================================
-- CHAT_INVOICES POLICIES
-- ================================

-- Policy: Users can view invoices where they are vendor or buyer
CREATE POLICY "Users can view their invoices"
ON chat_invoices
FOR SELECT
USING (
    auth.uid() = vendor_id
    OR auth.uid() = buyer_id
);

-- Policy: Vendors and riders can create invoices (must be is_seller or is_rider)
CREATE POLICY "Sellers and riders can create invoices"
ON chat_invoices
FOR INSERT
WITH CHECK (
    auth.uid() = vendor_id
    AND EXISTS (
        SELECT 1 FROM user_profiles
        WHERE id = auth.uid()
        AND (is_seller = true OR is_rider = true)
    )
);

-- Policy: Vendors can update their own invoices (only if status is pending and not expired)
CREATE POLICY "Vendors can update their pending invoices"
ON chat_invoices
FOR UPDATE
USING (
    auth.uid() = vendor_id
    AND status = 'pending'
    AND expires_at > NOW()
)
WITH CHECK (
    auth.uid() = vendor_id
    AND status IN ('pending', 'cancelled')
);

-- Policy: Vendors can delete their own pending invoices
CREATE POLICY "Vendors can delete their pending invoices"
ON chat_invoices
FOR DELETE
USING (
    auth.uid() = vendor_id
    AND status = 'pending'
);

-- ================================
-- CHAT_INVOICE_ITEMS POLICIES
-- ================================

-- Policy: Users can view invoice items if they can view the invoice
CREATE POLICY "Users can view invoice items for their invoices"
ON chat_invoice_items
FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM chat_invoices
        WHERE chat_invoices.id = chat_invoice_items.invoice_id
        AND (chat_invoices.vendor_id = auth.uid() OR chat_invoices.buyer_id = auth.uid())
    )
);

-- Policy: Vendors can insert invoice items for their own invoices
CREATE POLICY "Vendors can insert invoice items for their invoices"
ON chat_invoice_items
FOR INSERT
WITH CHECK (
    EXISTS (
        SELECT 1 FROM chat_invoices
        WHERE chat_invoices.id = chat_invoice_items.invoice_id
        AND chat_invoices.vendor_id = auth.uid()
        AND chat_invoices.status = 'pending'
    )
);

-- Policy: Vendors can delete invoice items for their pending invoices
CREATE POLICY "Vendors can delete invoice items from pending invoices"
ON chat_invoice_items
FOR DELETE
USING (
    EXISTS (
        SELECT 1 FROM chat_invoices
        WHERE chat_invoices.id = chat_invoice_items.invoice_id
        AND chat_invoices.vendor_id = auth.uid()
        AND chat_invoices.status = 'pending'
    )
);

-- ================================
-- SERVICE ROLE BYPASS
-- ================================

-- Service role can do everything (for backend operations)
CREATE POLICY "Service role has full access to invoices"
ON chat_invoices
FOR ALL
USING (auth.jwt()->>'role' = 'service_role')
WITH CHECK (auth.jwt()->>'role' = 'service_role');

CREATE POLICY "Service role has full access to invoice items"
ON chat_invoice_items
FOR ALL
USING (auth.jwt()->>'role' = 'service_role')
WITH CHECK (auth.jwt()->>'role' = 'service_role');

COMMIT;
