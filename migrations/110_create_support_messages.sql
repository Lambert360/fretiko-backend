-- Migration: Create support messages table
-- Date: 2026-04-09
-- Description: Support messages management system for website contact and support

-- Create support_messages table
CREATE TABLE IF NOT EXISTS support_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Message Information
    type VARCHAR(50) NOT NULL 
        CHECK (type IN ('contact', 'partnership_general', 'partnership_logistics', 'legal', 'careers')),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    subject VARCHAR(500) NOT NULL,
    message TEXT NOT NULL,
    
    -- Optional Information
    phone VARCHAR(50),
    company VARCHAR(255),
    
    -- Status and Assignment
    status VARCHAR(50) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'resolved', 'closed')),
    assigned_to UUID REFERENCES staff_accounts(id),
    
    -- Admin Information
    admin_notes TEXT,
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    
    -- Timestamps
    replied_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_support_messages_type ON support_messages(type);
CREATE INDEX IF NOT EXISTS idx_support_messages_status ON support_messages(status);
CREATE INDEX IF NOT EXISTS idx_support_messages_email ON support_messages(email);
CREATE INDEX IF NOT EXISTS idx_support_messages_assigned_to ON support_messages(assigned_to);
CREATE INDEX IF NOT EXISTS idx_support_messages_created_at ON support_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_messages_replied_at ON support_messages(replied_at DESC);

-- Create trigger for updated_at
CREATE OR REPLACE FUNCTION update_support_messages_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER support_messages_updated_at
    BEFORE UPDATE ON support_messages
    FOR EACH ROW EXECUTE FUNCTION update_support_messages_updated_at();

-- Add comments
COMMENT ON TABLE support_messages IS 'Support messages for website contact and support management';
COMMENT ON COLUMN support_messages.type IS 'Message type: contact, partnership_general, partnership_logistics, legal, or careers';
COMMENT ON COLUMN support_messages.status IS 'Message status: pending, in_progress, resolved, or closed';
COMMENT ON COLUMN support_messages.assigned_to IS 'Staff member assigned to handle the message';
COMMENT ON COLUMN support_messages.admin_notes IS 'Internal notes about the message';
COMMENT ON COLUMN support_messages.metadata IS 'Additional metadata as JSON';
COMMENT ON COLUMN support_messages.replied_at IS 'Timestamp when message was first replied to';
