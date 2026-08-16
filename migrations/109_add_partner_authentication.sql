-- Migration: Add Partner Authentication
-- Date: 2026-04-06
-- Description: Add authentication fields for verified logistics partners

-- Add authentication columns to verified_logistics_partners
ALTER TABLE verified_logistics_partners 
ADD COLUMN partner_username VARCHAR(100) UNIQUE,
ADD COLUMN partner_password_hash VARCHAR(255),
ADD COLUMN partner_email_verified BOOLEAN DEFAULT FALSE,
ADD COLUMN partner_last_login TIMESTAMP WITH TIME ZONE,
ADD COLUMN partner_login_attempts INTEGER DEFAULT 0,
ADD COLUMN partner_locked_until TIMESTAMP WITH TIME ZONE,
ADD COLUMN partner_password_reset_token VARCHAR(255),
ADD COLUMN partner_password_reset_expires TIMESTAMP WITH TIME ZONE,
ADD COLUMN partner_created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
ADD COLUMN partner_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Create index for username lookup
CREATE INDEX idx_verified_logistics_partners_username ON verified_logistics_partners(partner_username);

-- Create index for password reset token
CREATE INDEX idx_verified_logistics_partners_reset_token ON verified_logistics_partners(partner_password_reset_token);

-- Add comments
COMMENT ON COLUMN verified_logistics_partners.partner_username IS 'Unique username for partner login (optional, can use company_id)';
COMMENT ON COLUMN verified_logistics_partners.partner_password_hash IS 'Hashed password for partner authentication';
COMMENT ON COLUMN verified_logistics_partners.partner_email_verified IS 'Whether partner email has been verified';
COMMENT ON COLUMN verified_logistics_partners.partner_last_login IS 'Timestamp of last successful login';
COMMENT ON COLUMN verified_logistics_partners.partner_login_attempts IS 'Number of failed login attempts';
COMMENT ON COLUMN verified_logistics_partners.partner_locked_until IS 'Account locked until this time after failed attempts';
COMMENT ON COLUMN verified_logistics_partners.partner_password_reset_token IS 'Token for password reset';
COMMENT ON COLUMN verified_logistics_partners.partner_password_reset_expires IS 'Expiration time for password reset token';

-- Create function to generate partner credentials when a partner is verified
CREATE OR REPLACE FUNCTION generate_partner_credentials()
RETURNS TRIGGER AS $$
DECLARE
    temp_username VARCHAR(100);
    temp_password VARCHAR(20);
    password_hash VARCHAR(255);
BEGIN
    -- Only generate credentials for newly verified partners who don't have them yet
    IF TG_OP = 'INSERT' AND NEW.partner_username IS NULL AND NEW.partner_password_hash IS NULL THEN
        -- Generate username from company name (lowercase, no spaces, add random suffix)
        temp_username := LOWER(REGEXP_REPLACE(NEW.company_name, '[^a-zA-Z0-9]', '', 'g'));
        temp_username := temp_username || '_' || substr(md5(gen_random_uuid()::text), 1, 6);
        
        -- Generate temporary password (8 characters)
        temp_password := substr(md5(gen_random_uuid()::text), 1, 8);
        
        -- Hash the password
        password_hash := crypt(temp_password, gen_salt('bf'));
        
        -- Update the new record with credentials
        NEW.partner_username := temp_username;
        NEW.partner_password_hash := password_hash;
        
        -- Log the generated credentials (in production, this should be sent via email)
        RAISE LOG 'Generated partner credentials for %: username=%, password=%', 
                    NEW.company_name, temp_username, temp_password;
    END IF;
    
    -- Update the updated_at timestamp
    NEW.partner_updated_at := NOW();
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically generate partner credentials
CREATE TRIGGER verified_logistics_partners_generate_credentials
    BEFORE INSERT OR UPDATE ON verified_logistics_partners
    FOR EACH ROW
    EXECUTE FUNCTION generate_partner_credentials();

-- Create function to validate partner login
CREATE OR REPLACE FUNCTION validate_partner_login(p_username VARCHAR, p_password VARCHAR)
RETURNS TABLE(
    partner_id UUID,
    company_name VARCHAR,
    success BOOLEAN,
    message VARCHAR,
    requires_password_change BOOLEAN
) AS $$
DECLARE
    partner_record RECORD;
    is_locked BOOLEAN;
    requires_change BOOLEAN;
BEGIN
    -- Get partner record
    SELECT * INTO partner_record 
    FROM verified_logistics_partners 
    WHERE partner_username = p_username AND partner_status = 'active';
    
    -- Check if partner exists
    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::UUID, NULL::VARCHAR, FALSE, 'Invalid username or password', FALSE;
        RETURN;
    END IF;
    
    -- Check if account is locked
    is_locked := partner_record.partner_locked_until > NOW();
    IF is_locked THEN
        RETURN QUERY SELECT partner_record.id, partner_record.company_name, FALSE, 'Account locked. Try again later.', FALSE;
        RETURN;
    END IF;
    
    -- Validate password
    IF partner_record.partner_password_hash IS NULL OR 
       NOT (partner_record.partner_password_hash = crypt(p_password, partner_record.partner_password_hash)) THEN
        
        -- Increment login attempts
        UPDATE verified_logistics_partners 
        SET partner_login_attempts = partner_login_attempts + 1,
            partner_updated_at = NOW()
        WHERE id = partner_record.id;
        
        -- Lock account after 5 failed attempts
        IF partner_record.partner_login_attempts + 1 >= 5 THEN
            UPDATE verified_logistics_partners 
            SET partner_locked_until = NOW() + INTERVAL '30 minutes',
                partner_updated_at = NOW()
            WHERE id = partner_record.id;
            
            RETURN QUERY SELECT partner_record.id, partner_record.company_name, FALSE, 'Account locked due to too many failed attempts. Try again in 30 minutes.', FALSE;
            RETURN;
        END IF;
        
        RETURN QUERY SELECT partner_record.id, partner_record.company_name, FALSE, 'Invalid username or password', FALSE;
        RETURN;
    END IF;
    
    -- Successful login - reset attempts and update last login
    UPDATE verified_logistics_partners 
    SET partner_login_attempts = 0,
        partner_last_login = NOW(),
        partner_updated_at = NOW()
    WHERE id = partner_record.id;
    
    -- Check if password change is required (first login or temporary password)
    requires_change := (partner_record.partner_last_login IS NULL);
    
    RETURN QUERY SELECT partner_record.id, partner_record.company_name, TRUE, 'Login successful', requires_change;
END;
$$ LANGUAGE plpgsql;

-- Create function to generate password reset token for partners
CREATE OR REPLACE FUNCTION generate_partner_password_reset_token(p_username VARCHAR)
RETURNS TABLE(
    success BOOLEAN,
    message VARCHAR,
    token VARCHAR
) AS $$
DECLARE
    partner_record RECORD;
    reset_token VARCHAR;
BEGIN
    -- Get partner record
    SELECT * INTO partner_record 
    FROM verified_logistics_partners 
    WHERE partner_username = p_username AND partner_status = 'active';
    
    -- Check if partner exists
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Partner not found', NULL::VARCHAR;
        RETURN;
    END IF;
    
    -- Generate reset token (32 characters)
    reset_token := encode(gen_random_bytes(32), 'hex');
    
    -- Update partner record with reset token
    UPDATE verified_logistics_partners 
    SET partner_password_reset_token = reset_token,
        partner_password_reset_expires = NOW() + INTERVAL '1 hour',
        partner_updated_at = NOW()
    WHERE id = partner_record.id;
    
    RETURN QUERY SELECT TRUE, 'Password reset token generated', reset_token;
END;
$$ LANGUAGE plpgsql;

-- Create function to reset partner password with token
CREATE OR REPLACE FUNCTION reset_partner_password_with_token(p_token VARCHAR, p_new_password VARCHAR)
RETURNS TABLE(
    success BOOLEAN,
    message VARCHAR
) AS $$
DECLARE
    partner_record RECORD;
    password_hash VARCHAR;
BEGIN
    -- Get partner record by token
    SELECT * INTO partner_record 
    FROM verified_logistics_partners 
    WHERE partner_password_reset_token = p_token 
      AND partner_password_reset_expires > NOW()
      AND partner_status = 'active';
    
    -- Check if token is valid
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Invalid or expired reset token';
        RETURN;
    END IF;
    
    -- Hash new password
    password_hash := crypt(p_new_password, gen_salt('bf'));
    
    -- Update password and clear reset token
    UPDATE verified_logistics_partners 
    SET partner_password_hash = password_hash,
        partner_password_reset_token = NULL,
        partner_password_reset_expires = NULL,
        partner_updated_at = NOW()
    WHERE id = partner_record.id;
    
    RETURN QUERY SELECT TRUE, 'Password reset successful';
END;
$$ LANGUAGE plpgsql;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION validate_partner_login TO service_role;
GRANT EXECUTE ON FUNCTION generate_partner_password_reset_token TO service_role;
GRANT EXECUTE ON FUNCTION reset_partner_password_with_token TO service_role;

COMMIT;
