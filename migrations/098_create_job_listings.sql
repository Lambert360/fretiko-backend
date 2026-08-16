-- Migration: Create job listings table
-- Date: 2026-04-03
-- Description: Job listings management system for careers page

-- Create job_listings table
CREATE TABLE IF NOT EXISTS job_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Job Information
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    requirements TEXT[] DEFAULT '{}',
    
    -- Location and Type
    location VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL DEFAULT 'full-time' 
        CHECK (type IN ('full-time', 'part-time', 'contract', 'internship')),
    department VARCHAR(255) NOT NULL,
    salary VARCHAR(100) NOT NULL,
    
    -- Publication Status
    status VARCHAR(20) NOT NULL DEFAULT 'draft' 
        CHECK (status IN ('draft', 'published')),
    
    -- Metadata
    experience_level VARCHAR(50),
    remote_work BOOLEAN DEFAULT false,
    
    -- Timestamps
    published_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_job_listings_title ON job_listings(title);
CREATE INDEX IF NOT EXISTS idx_job_listings_location ON job_listings(location);
CREATE INDEX IF NOT EXISTS idx_job_listings_department ON job_listings(department);
CREATE INDEX IF NOT EXISTS idx_job_listings_type ON job_listings(type);
CREATE INDEX IF NOT EXISTS idx_job_listings_status ON job_listings(status);
CREATE INDEX IF NOT EXISTS idx_job_listings_published_at ON job_listings(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_listings_experience_level ON job_listings(experience_level);
CREATE INDEX IF NOT EXISTS idx_job_listings_remote_work ON job_listings(remote_work);
CREATE INDEX IF NOT EXISTS idx_job_listings_requirements ON job_listings USING GIN(requirements);

-- Create trigger for updated_at
CREATE OR REPLACE FUNCTION update_job_listings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER job_listings_updated_at
    BEFORE UPDATE ON job_listings
    FOR EACH ROW EXECUTE FUNCTION update_job_listings_updated_at();

-- Add comments
COMMENT ON TABLE job_listings IS 'Job listings for careers page management';
COMMENT ON COLUMN job_listings.status IS 'Publication status: draft or published';
COMMENT ON COLUMN job_listings.type IS 'Employment type: full-time, part-time, contract, or internship';
COMMENT ON COLUMN job_listings.requirements IS 'Array of job requirements';
COMMENT ON COLUMN job_listings.remote_work IS 'Whether the position supports remote work';
COMMENT ON COLUMN job_listings.experience_level IS 'Required experience level: entry, mid, senior, etc.';
