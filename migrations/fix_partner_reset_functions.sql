-- Fix: Partner password reset functions
-- Must DROP first because PostgreSQL cannot change return types via CREATE OR REPLACE
DROP FUNCTION IF EXISTS generate_partner_password_reset_token(VARCHAR);
DROP FUNCTION IF EXISTS reset_partner_password_with_token(VARCHAR, VARCHAR);
DROP FUNCTION IF EXISTS validate_partner_login(VARCHAR, VARCHAR);


-- Error: "Returned type text does not match expected type character varying in column 2"
-- Root cause: encode() returns TEXT, and string literals in RETURN QUERY SELECT are TEXT,
--             but the original functions declared return columns as VARCHAR.
--             PostgreSQL treats TEXT and VARCHAR as distinct types in function return checking.
-- Fix: Change VARCHAR to TEXT in return type declarations for all partner auth functions.

-- Fix generate_partner_password_reset_token
CREATE OR REPLACE FUNCTION generate_partner_password_reset_token(p_username VARCHAR)
RETURNS TABLE(
    success BOOLEAN,
    message TEXT,
    token TEXT
) AS $$
DECLARE
    partner_record RECORD;
    reset_token TEXT;
BEGIN
    -- Get partner record
    SELECT * INTO partner_record 
    FROM verified_logistics_partners 
    WHERE partner_username = p_username AND partner_status = 'active';
    
    -- Check if partner exists
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Partner not found'::TEXT, NULL::TEXT;
        RETURN;
    END IF;
    
    -- Generate reset token (64 hex characters = 32 random bytes)
    reset_token := encode(gen_random_bytes(32), 'hex');
    
    -- Update partner record with reset token
    UPDATE verified_logistics_partners 
    SET partner_password_reset_token = reset_token,
        partner_password_reset_expires = NOW() + INTERVAL '1 hour',
        partner_updated_at = NOW()
    WHERE id = partner_record.id;
    
    RETURN QUERY SELECT TRUE, 'Password reset token generated'::TEXT, reset_token;
END;
$$ LANGUAGE plpgsql;

-- Fix reset_partner_password_with_token
CREATE OR REPLACE FUNCTION reset_partner_password_with_token(p_token VARCHAR, p_new_password VARCHAR)
RETURNS TABLE(
    success BOOLEAN,
    message TEXT
) AS $$
DECLARE
    partner_record RECORD;
    password_hash TEXT;
BEGIN
    -- Get partner record by token
    SELECT * INTO partner_record 
    FROM verified_logistics_partners 
    WHERE partner_password_reset_token = p_token 
      AND partner_password_reset_expires > NOW()
      AND partner_status = 'active';
    
    -- Check if token is valid
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Invalid or expired reset token'::TEXT;
        RETURN;
    END IF;
    
    -- Hash new password
    password_hash := crypt(p_new_password, gen_salt('bf'));
    
    -- Update password and clear reset token
    UPDATE verified_logistics_partners 
    SET partner_password_hash = password_hash,
        partner_password_reset_token = NULL,
        partner_password_reset_expires = NULL,
        partner_login_attempts = 0,
        partner_updated_at = NOW()
    WHERE id = partner_record.id;
    
    RETURN QUERY SELECT TRUE, 'Password reset successful'::TEXT;
END;
$$ LANGUAGE plpgsql;

-- Also fix validate_partner_login to use TEXT (same potential issue)
CREATE OR REPLACE FUNCTION validate_partner_login(p_username VARCHAR, p_password VARCHAR)
RETURNS TABLE(
    partner_id UUID,
    company_name TEXT,
    success BOOLEAN,
    message TEXT,
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
        RETURN QUERY SELECT NULL::UUID, NULL::TEXT, FALSE, 'Invalid username or password'::TEXT, FALSE;
        RETURN;
    END IF;
    
    -- Check if account is locked
    is_locked := (partner_record.partner_locked_until IS NOT NULL AND partner_record.partner_locked_until > NOW());
    IF is_locked THEN
        RETURN QUERY SELECT partner_record.id, partner_record.company_name::TEXT, FALSE, 'Account locked. Try again later.'::TEXT, FALSE;
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
            
            RETURN QUERY SELECT partner_record.id, partner_record.company_name::TEXT, FALSE, 'Account locked due to too many failed attempts. Try again in 30 minutes.'::TEXT, FALSE;
            RETURN;
        END IF;
        
        RETURN QUERY SELECT partner_record.id, partner_record.company_name::TEXT, FALSE, 'Invalid username or password'::TEXT, FALSE;
        RETURN;
    END IF;
    
    -- Successful login - reset attempts and update last login
    UPDATE verified_logistics_partners 
    SET partner_login_attempts = 0,
        partner_last_login = NOW(),
        partner_updated_at = NOW()
    WHERE id = partner_record.id;
    
    -- Check if password change is required (first login = partner_last_login was NULL before update)
    requires_change := (partner_record.partner_last_login IS NULL);
    
    RETURN QUERY SELECT partner_record.id, partner_record.company_name::TEXT, TRUE, 'Login successful'::TEXT, requires_change;
END;
$$ LANGUAGE plpgsql;

-- Re-grant permissions
GRANT EXECUTE ON FUNCTION validate_partner_login TO service_role;
GRANT EXECUTE ON FUNCTION generate_partner_password_reset_token TO service_role;
GRANT EXECUTE ON FUNCTION reset_partner_password_with_token TO service_role;
