-- Test function creation step by step
-- Run this first to isolate the issue

-- Step 1: Check if user_profiles has the required columns
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'user_profiles' 
AND table_schema = 'public'
AND column_name IN ('email_confirmation_token', 'email_confirmation_expires_at');

-- Step 2: Try creating just the token generation function
CREATE OR REPLACE FUNCTION public.generate_email_verification_token()
RETURNS TEXT AS $$
DECLARE
    token TEXT;
BEGIN
    token := encode(gen_random_bytes(16), 'hex');
    RETURN token;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 3: Try creating the validation function only if columns exist
-- (This will show us the exact error)
