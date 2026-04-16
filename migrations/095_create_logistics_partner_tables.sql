-- Migration: Create logistics partnership system tables
-- Date: 2026-03-22
-- Description: Comprehensive logistics partnership and rider verification system

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Create logistics_partner_applications table
CREATE TABLE IF NOT EXISTS logistics_partner_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tracking_id VARCHAR(20) UNIQUE NOT NULL,
    
    -- Company Information
    company_name VARCHAR(255) NOT NULL,
    company_logo_url TEXT,
    company_registration_number VARCHAR(100),
    tax_id VARCHAR(50),
    
    -- Contact Information
    contact_person_name VARCHAR(255) NOT NULL,
    contact_email VARCHAR(255) NOT NULL,
    contact_phone VARCHAR(50),
    company_website VARCHAR(500),
    
    -- Location Information
    headquarters_address TEXT NOT NULL,
    service_areas TEXT[] DEFAULT '{}',
    operating_hours JSONB DEFAULT '{}',
    
    -- Fleet Information
    vehicle_fleet JSONB DEFAULT '{}', -- {type: count, photos: []}
    total_riders INTEGER DEFAULT 0,
    average_daily_deliveries INTEGER DEFAULT 0,
    
    -- Business Information
    years_in_operation INTEGER,
    insurance_coverage JSONB DEFAULT '{}',
    service_categories TEXT[] DEFAULT '{}',
    
    -- Documents
    registration_document_urls TEXT[] DEFAULT '{}',
    insurance_document_urls TEXT[] DEFAULT '{}',
    fleet_document_urls TEXT[] DEFAULT '{}',
    
    -- Application Status
    status VARCHAR(20) DEFAULT 'in_progress' 
        CHECK (status IN ('in_progress', 'under_review', 'verified', 'rejected')),
    rejection_reason TEXT,
    admin_notes TEXT,
    
    -- Review Process
    reviewed_by UUID REFERENCES staff_accounts(id),
    reviewed_at TIMESTAMP WITH TIME ZONE,
    verification_details JSONB DEFAULT '{}',
    
    -- Notifications
    application_email_sent BOOLEAN DEFAULT FALSE,
    review_email_sent BOOLEAN DEFAULT FALSE,
    decision_email_sent BOOLEAN DEFAULT FALSE,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create verified_logistics_partners table
CREATE TABLE IF NOT EXISTS verified_logistics_partners (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID REFERENCES logistics_partner_applications(id) UNIQUE,
    company_id UUID REFERENCES logistics_partner_applications(id) UNIQUE,
    
    -- Company Information (copied from application)
    company_name VARCHAR(255) NOT NULL,
    company_logo_url TEXT,
    contact_email VARCHAR(255) NOT NULL,
    contact_phone VARCHAR(50),
    headquarters_address TEXT NOT NULL,
    service_areas TEXT[] DEFAULT '{}',
    
    -- Partner Status
    partner_status VARCHAR(20) DEFAULT 'active' 
        CHECK (partner_status IN ('active', 'suspended', 'terminated')),
    
    -- Performance Metrics
    total_riders INTEGER DEFAULT 0,
    active_riders INTEGER DEFAULT 0,
    total_deliveries INTEGER DEFAULT 0,
    completed_deliveries INTEGER DEFAULT 0,
    average_delivery_time DECIMAL(10,2), -- in minutes
    on_time_delivery_rate DECIMAL(5,2), -- percentage
    
    -- Revenue
    total_revenue DECIMAL(15,2) DEFAULT 0.00,
    platform_commission DECIMAL(15,2) DEFAULT 0.00,
    
    -- Verification Details
    verified_by UUID REFERENCES staff_accounts(id),
    verified_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    verification_notes TEXT,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create rider_verification_requests table
CREATE TABLE IF NOT EXISTS rider_verification_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Rider Information
    user_id UUID REFERENCES user_profiles(id) UNIQUE NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    country VARCHAR(100) NOT NULL,
    state VARCHAR(100) NOT NULL,
    city VARCHAR(100),
    
    -- Vehicle Information
    vehicle_type VARCHAR(50) NOT NULL,
    vehicle_make VARCHAR(100),
    vehicle_model VARCHAR(100),
    vehicle_year INTEGER,
    license_plate VARCHAR(50),
    
    -- Company Affiliation
    company_id UUID REFERENCES verified_logistics_partners(id),
    company_name VARCHAR(255),
    
    -- Documents
    driver_license_url TEXT,
    vehicle_registration_url TEXT,
    insurance_document_url TEXT,
    profile_photo_url TEXT,
    
    -- Experience
    years_experience INTEGER,
    previous_delivery_companies TEXT[] DEFAULT '{}',
    
    -- Verification Status
    status VARCHAR(20) DEFAULT 'in_progress'
        CHECK (status IN ('in_progress', 'under_review', 'verified', 'rejected')),
    rejection_reason TEXT,
    admin_notes TEXT,
    
    -- Review Process
    reviewed_by UUID REFERENCES staff_accounts(id),
    reviewed_at TIMESTAMP WITH TIME ZONE,
    verification_details JSONB DEFAULT '{}',
    
    -- Notifications
    application_email_sent BOOLEAN DEFAULT FALSE,
    review_email_sent BOOLEAN DEFAULT FALSE,
    decision_email_sent BOOLEAN DEFAULT FALSE,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create verified_riders table
CREATE TABLE IF NOT EXISTS verified_riders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES user_profiles(id) UNIQUE NOT NULL,
    verification_request_id UUID REFERENCES rider_verification_requests(id) UNIQUE,
    
    -- Rider Details (copied from verification request)
    full_name VARCHAR(255) NOT NULL,
    vehicle_type VARCHAR(50) NOT NULL,
    company_id UUID REFERENCES verified_logistics_partners(id),
    
    -- Verification Status
    verification_status VARCHAR(20) DEFAULT 'active'
        CHECK (verification_status IN ('active', 'suspended', 'terminated')),
    
    -- Performance Metrics
    total_deliveries INTEGER DEFAULT 0,
    completed_deliveries INTEGER DEFAULT 0,
    average_delivery_time DECIMAL(10,2),
    customer_rating DECIMAL(3,2),
    on_time_rate DECIMAL(5,2),
    
    -- Verification Details
    verified_by UUID REFERENCES staff_accounts(id),
    verified_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    verification_notes TEXT,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create application_status_history table
CREATE TABLE IF NOT EXISTS application_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_type VARCHAR(20) NOT NULL 
        CHECK (application_type IN ('company', 'rider')),
    application_id UUID NOT NULL,
    
    old_status VARCHAR(20),
    new_status VARCHAR(20) NOT NULL,
    
    changed_by UUID REFERENCES staff_accounts(id),
    change_reason TEXT,
    notes TEXT,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_logistics_partner_applications_tracking_id ON logistics_partner_applications(tracking_id);
CREATE INDEX IF NOT EXISTS idx_logistics_partner_applications_status ON logistics_partner_applications(status);
CREATE INDEX IF NOT EXISTS idx_logistics_partner_applications_created_at ON logistics_partner_applications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logistics_partner_applications_contact_email ON logistics_partner_applications(contact_email);

CREATE INDEX IF NOT EXISTS idx_verified_logistics_partners_application_id ON verified_logistics_partners(application_id);
CREATE INDEX IF NOT EXISTS idx_verified_logistics_partners_status ON verified_logistics_partners(partner_status);
CREATE INDEX IF NOT EXISTS idx_verified_logistics_partners_company_id ON verified_logistics_partners(company_id);

CREATE INDEX IF NOT EXISTS idx_rider_verification_requests_user_id ON rider_verification_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_rider_verification_requests_status ON rider_verification_requests(status);
CREATE INDEX IF NOT EXISTS idx_rider_verification_requests_company_id ON rider_verification_requests(company_id);
CREATE INDEX IF NOT EXISTS idx_rider_verification_requests_created_at ON rider_verification_requests(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_verified_riders_user_id ON verified_riders(user_id);
CREATE INDEX IF NOT EXISTS idx_verified_riders_company_id ON verified_riders(company_id);
CREATE INDEX IF NOT EXISTS idx_verified_riders_verification_status ON verified_riders(verification_status);

CREATE INDEX IF NOT EXISTS idx_application_status_history_application_id ON application_status_history(application_id);
CREATE INDEX IF NOT EXISTS idx_application_status_history_created_at ON application_status_history(created_at DESC);

-- Enable Row Level Security
ALTER TABLE logistics_partner_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE verified_logistics_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE rider_verification_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE verified_riders ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_status_history ENABLE ROW LEVEL SECURITY;

-- RLS Policies for logistics_partner_applications
CREATE POLICY logistics_partner_applications_public_insert ON logistics_partner_applications
    FOR INSERT TO authenticated
    WITH CHECK (true);

CREATE POLICY logistics_partner_applications_public_select_tracking ON logistics_partner_applications
    FOR SELECT TO authenticated
    USING (true);

CREATE POLICY logistics_partner_applications_service_all ON logistics_partner_applications
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- RLS Policies for verified_logistics_partners
CREATE POLICY verified_logistics_partners_public_select ON verified_logistics_partners
    FOR SELECT TO authenticated
    USING (partner_status = 'active');

CREATE POLICY verified_logistics_partners_service_all ON verified_logistics_partners
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- RLS Policies for rider_verification_requests
CREATE POLICY rider_verification_requests_own_select ON rider_verification_requests
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY rider_verification_requests_own_insert ON rider_verification_requests
    FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

CREATE POLICY rider_verification_requests_service_all ON rider_verification_requests
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- RLS Policies for verified_riders
CREATE POLICY verified_riders_public_select ON verified_riders
    FOR SELECT TO authenticated
    USING (verification_status = 'active');

CREATE POLICY verified_riders_service_all ON verified_riders
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- RLS Policies for application_status_history
CREATE POLICY application_status_history_service_all ON application_status_history
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- Create trigger to update updated_at timestamps
CREATE OR REPLACE FUNCTION update_logistics_tables_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers
CREATE TRIGGER logistics_partner_applications_updated_at
    BEFORE UPDATE ON logistics_partner_applications
    FOR EACH ROW
    EXECUTE FUNCTION update_logistics_tables_updated_at();

CREATE TRIGGER verified_logistics_partners_updated_at
    BEFORE UPDATE ON verified_logistics_partners
    FOR EACH ROW
    EXECUTE FUNCTION update_logistics_tables_updated_at();

CREATE TRIGGER rider_verification_requests_updated_at
    BEFORE UPDATE ON rider_verification_requests
    FOR EACH ROW
    EXECUTE FUNCTION update_logistics_tables_updated_at();

CREATE TRIGGER verified_riders_updated_at
    BEFORE UPDATE ON verified_riders
    FOR EACH ROW
    EXECUTE FUNCTION update_logistics_tables_updated_at();

-- Create function to generate unique tracking ID
CREATE OR REPLACE FUNCTION generate_tracking_id()
RETURNS TEXT AS $$
DECLARE
    tracking_id TEXT;
    prefix TEXT := 'FP'; -- Fretiko Partner
BEGIN
    LOOP
        -- Use gen_random_uuid() and extract last 8 characters for better randomness
        tracking_id := prefix || upper(substr(md5(gen_random_uuid()::text), 1, 8));
        EXIT WHEN NOT EXISTS (SELECT 1 FROM logistics_partner_applications WHERE tracking_id = tracking_id);
    END LOOP;
    RETURN tracking_id;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-generate tracking ID
CREATE OR REPLACE FUNCTION auto_generate_tracking_id()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.tracking_id IS NULL THEN
        NEW.tracking_id := generate_tracking_id();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER logistics_partner_applications_tracking_id
    BEFORE INSERT ON logistics_partner_applications
    FOR EACH ROW
    EXECUTE FUNCTION auto_generate_tracking_id();

-- Add comments for documentation
COMMENT ON TABLE logistics_partner_applications IS 'Stores logistics partnership applications from companies';
COMMENT ON TABLE verified_logistics_partners IS 'Stores verified logistics partner companies with performance metrics';
COMMENT ON TABLE rider_verification_requests IS 'Stores rider verification requests with company affiliation';
COMMENT ON TABLE verified_riders IS 'Stores verified riders with performance tracking';
COMMENT ON TABLE application_status_history IS 'Audit trail for application status changes';

COMMENT ON COLUMN logistics_partner_applications.tracking_id IS 'Unique tracking ID for application status lookup';
COMMENT ON COLUMN logistics_partner_applications.vehicle_fleet IS 'JSONB structure: {type: count, photos: [urls]}';
COMMENT ON COLUMN logistics_partner_applications.service_areas IS 'Array of service area names or regions';
COMMENT ON COLUMN logistics_partner_applications.operating_hours IS 'JSONB structure with daily operating hours';

COMMENT ON COLUMN verified_logistics_partners.partner_status IS 'Current status of partner: active, suspended, terminated';
COMMENT ON COLUMN verified_logistics_partners.company_id IS 'Reference to original partner application for moderation';
COMMENT ON COLUMN verified_logistics_partners.total_revenue IS 'Total revenue generated by partner';
COMMENT ON COLUMN verified_logistics_partners.platform_commission IS 'Total commission earned by platform from partner';

COMMENT ON COLUMN rider_verification_requests.company_id IS 'Reference to verified logistics partner company';
COMMENT ON COLUMN rider_verification_requests.status IS 'Verification status: in_progress, under_review, verified, rejected';

COMMENT ON COLUMN verified_riders.verification_status IS 'Current verification status: active, suspended, terminated';
COMMENT ON COLUMN verified_riders.company_id IS 'Reference to verified logistics partner company';

COMMENT ON COLUMN application_status_history.application_type IS 'Type of application: company or rider';
COMMENT ON COLUMN application_status_history.changed_by IS 'Staff user who made the status change';

-- Grant permissions
GRANT SELECT, INSERT, UPDATE ON logistics_partner_applications TO authenticated;
GRANT SELECT, INSERT, UPDATE ON verified_logistics_partners TO authenticated;
GRANT SELECT, INSERT, UPDATE ON rider_verification_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE ON verified_riders TO authenticated;
GRANT SELECT, INSERT, UPDATE ON application_status_history TO authenticated;

-- Service role needs full access
GRANT ALL ON logistics_partner_applications TO service_role;
GRANT ALL ON verified_logistics_partners TO service_role;
GRANT ALL ON rider_verification_requests TO service_role;
GRANT ALL ON verified_riders TO service_role;
GRANT ALL ON application_status_history TO service_role;

-- Grant execute permissions for functions
GRANT EXECUTE ON FUNCTION generate_tracking_id TO service_role;
GRANT EXECUTE ON FUNCTION auto_generate_tracking_id TO service_role;

COMMIT;
