-- Migration: Fix ambiguous tracking_id reference in triggers
-- Date: 2026-04-05
-- Description: Fix the auto_generate_tracking_id function to avoid ambiguous column references

-- Drop the existing trigger and function
DROP TRIGGER IF EXISTS logistics_partner_applications_tracking_id ON logistics_partner_applications;
DROP FUNCTION IF EXISTS auto_generate_tracking_id();

-- Recreate the function with explicit table qualification
CREATE OR REPLACE FUNCTION auto_generate_tracking_id()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.tracking_id IS NULL THEN
        NEW.tracking_id := generate_tracking_id();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate the trigger
CREATE TRIGGER logistics_partner_applications_tracking_id
    BEFORE INSERT ON logistics_partner_applications
    FOR EACH ROW
    EXECUTE FUNCTION auto_generate_tracking_id();
