-- Fix: Add change_partner_password_by_id function
-- The service's changePassword method was doing a raw UPDATE with plaintext password.
-- The generate_partner_credentials trigger only hashes on INSERT, not UPDATE.
-- This function handles bcrypt hashing consistently, matching reset_partner_password_with_token.

CREATE OR REPLACE FUNCTION change_partner_password_by_id(
    p_partner_id UUID,
    p_new_password VARCHAR
)
RETURNS TABLE(
    success BOOLEAN,
    message TEXT
) AS $$
DECLARE
    partner_record RECORD;
    password_hash TEXT;
BEGIN
    -- Verify partner exists and is active
    SELECT * INTO partner_record
    FROM verified_logistics_partners
    WHERE id = p_partner_id AND partner_status = 'active';

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'Partner not found'::TEXT;
        RETURN;
    END IF;

    -- Hash new password with bcrypt
    password_hash := crypt(p_new_password, gen_salt('bf'));

    -- Update password only
    UPDATE verified_logistics_partners
    SET partner_password_hash = password_hash,
        partner_login_attempts = 0,
        partner_updated_at = NOW()
    WHERE id = p_partner_id;

    RETURN QUERY SELECT TRUE, 'Password changed successfully'::TEXT;
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION change_partner_password_by_id TO service_role;
