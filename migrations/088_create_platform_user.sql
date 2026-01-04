-- Create Platform user record with fixed UUID
-- This ensures the platform wallet exists as a valid user in the system
-- Used to collect platform commissions from all services

BEGIN;

-- First, insert into auth.users if it doesn't exist (Supabase auth table)
INSERT INTO auth.users (
    id,
    instance_id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    confirmation_token,
    created_at,
    updated_at,
    raw_app_meta_data,
    raw_user_meta_data
) VALUES (
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'platform@fretiko.com',
    '',
    NOW(),
    '',
    NOW(),
    NOW(),
    '{"provider": "system", "providers": ["system"]}',
    '{"name": "Fretiko Platform"}'
)
ON CONFLICT (id) DO NOTHING;

-- Then, insert into user_profiles (app table)
INSERT INTO public.user_profiles (
    id,
    username,
    bio,
    avatar_url,
    location,
    preferences,
    is_seller,
    is_rider,
    created_at,
    updated_at
) VALUES (
    '00000000-0000-4000-8000-000000000002',
    'fretiko_platform',
    'Fretiko Platform Wallet - System account for collecting platform commissions',
    NULL,
    'System',
    '{"platform_wallet": true, "type": "system"}',
    false,
    false,
    NOW(),
    NOW()
)
ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    bio = EXCLUDED.bio,
    preferences = EXCLUDED.preferences,
    updated_at = NOW();

COMMIT;

