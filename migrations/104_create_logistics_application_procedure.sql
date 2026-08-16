-- Migration: Create stored procedure for logistics application creation
-- Date: 2026-04-05
-- Description: Create a stored procedure to avoid ambiguous column reference issues

CREATE OR REPLACE FUNCTION create_logistics_application(
    p_company_name VARCHAR(255) DEFAULT NULL,
    p_company_logo_url TEXT DEFAULT NULL,
    p_company_registration_number VARCHAR(100) DEFAULT NULL,
    p_tax_id VARCHAR(50) DEFAULT NULL,
    p_contact_person_name VARCHAR(255) DEFAULT NULL,
    p_contact_email VARCHAR(255) DEFAULT NULL,
    p_contact_phone VARCHAR(50) DEFAULT NULL,
    p_company_website VARCHAR(500) DEFAULT NULL,
    p_headquarters_address TEXT DEFAULT NULL,
    p_service_areas TEXT[] DEFAULT '{}',
    p_operating_hours JSONB DEFAULT '{}',
    p_vehicle_fleet JSONB DEFAULT '{}',
    p_total_riders INTEGER DEFAULT 0,
    p_average_daily_deliveries INTEGER DEFAULT 0,
    p_years_in_operation INTEGER DEFAULT NULL,
    p_insurance_coverage JSONB DEFAULT '{}',
    p_service_categories TEXT[] DEFAULT '{}',
    p_registration_document_urls TEXT[] DEFAULT '{}',
    p_insurance_document_urls TEXT[] DEFAULT '{}',
    p_fleet_document_urls TEXT[] DEFAULT '{}'
)
RETURNS TABLE(result_tracking_id VARCHAR(20)) AS $$
BEGIN
    INSERT INTO logistics_partner_applications (
        company_name,
        company_logo_url,
        company_registration_number,
        tax_id,
        contact_person_name,
        contact_email,
        contact_phone,
        company_website,
        headquarters_address,
        service_areas,
        operating_hours,
        vehicle_fleet,
        total_riders,
        average_daily_deliveries,
        years_in_operation,
        insurance_coverage,
        service_categories,
        registration_document_urls,
        insurance_document_urls,
        fleet_document_urls
    ) VALUES (
        p_company_name,
        p_company_logo_url,
        p_company_registration_number,
        p_tax_id,
        p_contact_person_name,
        p_contact_email,
        p_contact_phone,
        p_company_website,
        p_headquarters_address,
        p_service_areas,
        p_operating_hours,
        p_vehicle_fleet,
        p_total_riders,
        p_average_daily_deliveries,
        p_years_in_operation,
        p_insurance_coverage,
        p_service_categories,
        p_registration_document_urls,
        p_insurance_document_urls,
        p_fleet_document_urls
    )
    RETURNING logistics_partner_applications.tracking_id AS result_tracking_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permission to service role
GRANT EXECUTE ON FUNCTION create_logistics_application TO service_role;
