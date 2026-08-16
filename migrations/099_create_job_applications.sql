-- Migration: Create job applications table
-- Date: 2026-04-03
-- Description: Job applications tracking system for careers management

-- Create job_applications table
CREATE TABLE IF NOT EXISTS job_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Job Reference
    job_id UUID NOT NULL REFERENCES job_listings(id) ON DELETE CASCADE,
    job_title VARCHAR(255) NOT NULL,
    
    -- Applicant Information
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    
    -- Application Content
    resume VARCHAR(500),
    cover_letter TEXT,
    experience TEXT,
    education TEXT,
    portfolio VARCHAR(500),
    
    -- Application Status
    status VARCHAR(50) NOT NULL DEFAULT 'pending' 
        CHECK (status IN ('pending', 'reviewed', 'shortlisted', 'rejected', 'hired')),
    
    -- Review Information
    reviewed_by UUID REFERENCES staff_accounts(id),
    review_notes TEXT,
    
    -- Timestamps
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_job_applications_job_id ON job_applications(job_id);
CREATE INDEX IF NOT EXISTS idx_job_applications_status ON job_applications(status);
CREATE INDEX IF NOT EXISTS idx_job_applications_applied_at ON job_applications(applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_applications_email ON job_applications(email);
CREATE INDEX IF NOT EXISTS idx_job_applications_name ON job_applications(name);

-- Create trigger for updated_at
CREATE OR REPLACE FUNCTION update_job_applications_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER job_applications_updated_at
    BEFORE UPDATE ON job_applications
    FOR EACH ROW EXECUTE FUNCTION update_job_applications_updated_at();

-- Add comments
COMMENT ON TABLE job_applications IS 'Job applications for careers management system';
COMMENT ON COLUMN job_applications.status IS 'Application status: pending, reviewed, shortlisted, rejected, or hired';
COMMENT ON COLUMN job_applications.reviewed_by IS 'Staff member who reviewed the application';
COMMENT ON COLUMN job_applications.review_notes IS 'Internal notes about the application review';
