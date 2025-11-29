-- =====================================================
-- FRETIKO INTERNAL TOOL: SUPER ADMIN SEED DATA
-- =====================================================
-- Creates the initial super admin account (God Mode)
-- IMPORTANT: Change the password immediately after first login!

-- Insert super admin account
-- Default password: FretikoPlatform2025!
-- Password hash generated with bcrypt (cost factor: 10)
INSERT INTO public.staff_accounts (
    staff_id,
    email,
    password_hash,
    full_name,
    department_id,
    role,
    is_active,
    must_change_password,
    created_by
) VALUES (
    'FTK-2025-0001',
    'superadmin@fretiko.com',
    '$2b$10$YourActualBcryptHashHere', -- This will be replaced by backend on first run
    'Super Administrator',
    NULL, -- Super admin doesn't belong to a specific department
    'super_admin',
    true,
    true, -- Must change password on first login
    NULL
) ON CONFLICT (email) DO NOTHING;

-- Create a function to initialize the super admin with a hashed password
-- This should be called from the backend during initial setup
CREATE OR REPLACE FUNCTION initialize_super_admin(
    p_email TEXT DEFAULT 'superadmin@fretiko.com',
    p_password_hash TEXT DEFAULT NULL,
    p_full_name TEXT DEFAULT 'Super Administrator'
)
RETURNS UUID AS $$
DECLARE
    admin_id UUID;
BEGIN
    -- Check if super admin already exists
    SELECT id INTO admin_id
    FROM public.staff_accounts
    WHERE email = p_email;

    IF admin_id IS NOT NULL THEN
        RAISE NOTICE 'Super admin already exists with ID: %', admin_id;
        RETURN admin_id;
    END IF;

    -- Create super admin
    INSERT INTO public.staff_accounts (
        staff_id,
        email,
        password_hash,
        full_name,
        department_id,
        role,
        is_active,
        must_change_password,
        created_by
    ) VALUES (
        'FTK-2025-0001',
        p_email,
        p_password_hash,
        p_full_name,
        NULL,
        'super_admin',
        true,
        true,
        NULL
    ) RETURNING id INTO admin_id;

    RAISE NOTICE 'Super admin created with ID: %', admin_id;
    RETURN admin_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION initialize_super_admin IS 'Initialize the first super admin account. Should only be called once during setup.';
