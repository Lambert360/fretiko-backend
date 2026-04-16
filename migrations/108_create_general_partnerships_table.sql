-- Migration: Create general partnerships table
-- Date: 2026-04-06
-- Description: Create table for general partnership applications

-- Create general partnerships table
CREATE TABLE general_partnerships (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  company VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  partnership_type VARCHAR(50) NOT NULL,
  message TEXT,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add indexes for performance
CREATE INDEX idx_general_partnerships_email ON general_partnerships(email);
CREATE INDEX idx_general_partnerships_status ON general_partnerships(status);
CREATE INDEX idx_general_partnerships_created_at ON general_partnerships(created_at);

-- Row Level Security (RLS) Policies
-- Allow anonymous users to insert data (for form submissions)
CREATE POLICY "Allow public insert to general partnerships" ON general_partnerships
FOR INSERT WITH CHECK (
  auth.role() = 'anon'
);

-- Allow service role to manage all data
CREATE POLICY "Allow service role full access to general partnerships" ON general_partnerships
FOR ALL USING (
  auth.role() = 'service_role'
);

-- Allow authenticated users to read their own data
CREATE POLICY "Allow users to read own general partnerships" ON general_partnerships
FOR SELECT USING (
  auth.role() = 'authenticated' AND 
  id = auth.uid()
);

-- Grant permissions to service role
GRANT ALL ON general_partnerships TO service_role;
GRANT SELECT ON general_partnerships TO anon;
GRANT SELECT ON general_partnerships TO authenticated;

-- Comments
COMMENT ON TABLE general_partnerships IS 'General partnership applications from website';
COMMENT ON COLUMN general_partnerships.id IS 'Unique identifier for each partnership application';
COMMENT ON COLUMN general_partnerships.name IS 'Contact person name for the partnership';
COMMENT ON COLUMN general_partnerships.email IS 'Contact email (unique identifier)';
COMMENT ON COLUMN general_partnerships.company IS 'Company or organization name';
COMMENT ON COLUMN general_partnerships.phone IS 'Contact phone number';
COMMENT ON COLUMN general_partnerships.partnership_type IS 'Type of partnership (strategic, technology, marketing, etc.)';
COMMENT ON COLUMN general_partnerships.message IS 'Message from applicant describing partnership interest';
COMMENT ON COLUMN general_partnerships.status IS 'Current status of application (pending, under_review, approved, rejected)';
COMMENT ON COLUMN general_partnerships.created_at IS 'Timestamp when application was submitted';
COMMENT ON COLUMN general_partnerships.updated_at IS 'Timestamp when application was last updated';
