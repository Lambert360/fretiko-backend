-- Create AI Assistant user record with fixed UUID
-- This ensures the AI participant exists as a valid user in the system

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
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'ai-assistant@fretiko.com',
    '',
    NOW(),
    '',
    NOW(),
    NOW(),
    '{"provider": "system", "providers": ["system"]}',
    '{"name": "Iko AI Assistant"}'
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
    created_at,
    updated_at
) VALUES (
    '00000000-0000-4000-8000-000000000001',
    'iko_ai',
    'I am Iko, your friendly AI assistant here to help you with anything you need!',
    'https://images.unsplash.com/photo-1485827404703-89b55fcc595e?w=100&h=100&fit=crop&crop=face',
    'Digital Space',
    '{"ai_assistant": true, "type": "system"}',
    false,
    NOW(),
    NOW()
)
ON CONFLICT (id) DO UPDATE SET
    username = EXCLUDED.username,
    bio = EXCLUDED.bio,
    avatar_url = EXCLUDED.avatar_url,
    location = EXCLUDED.location,
    preferences = EXCLUDED.preferences,
    updated_at = NOW();

COMMIT;