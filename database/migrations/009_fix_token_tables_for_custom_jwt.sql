-- FIX TOKEN TABLES RLS POLICIES FOR CUSTOM JWT AUTHENTICATION
-- This migration fixes refresh_tokens and user_activity_log tables to work with custom JWT tokens
-- Instead of using auth.uid(), we'll use a custom function that extracts user ID from JWT

-- Step 1: Ensure get_current_user_id function exists (from migration 007)
-- If it doesn't exist, create it
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc WHERE proname = 'get_current_user_id'
    ) THEN
        CREATE OR REPLACE FUNCTION get_current_user_id()
        RETURNS UUID
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = public
        AS $func$
        DECLARE
            auth_header TEXT;
            token TEXT;
            payload TEXT;
            decoded_payload JSONB;
            user_id UUID;
        BEGIN
            -- Get the Authorization header from the current request
            auth_header := current_setting('request.headers', true);
            
            IF auth_header IS NULL OR auth_header = '' THEN
                RETURN NULL;
            END IF;
            
            -- Extract the Bearer token
            IF position('Bearer ' in auth_header) = 0 THEN
                RETURN NULL;
            END IF;
            
            token := trim(split_part(auth_header, 'Bearer ', 2));
            
            -- Decode the JWT payload (second part)
            payload := split_part(token, '.', 2);
            
            -- Base64 decode the payload
            BEGIN
                decoded_payload := convert_from(decode(payload, 'base64'), 'utf8')::jsonb;
            EXCEPTION
                WHEN OTHERS THEN
                    RETURN NULL;
            END;
            
            -- Extract the user ID (sub field)
            user_id := (decoded_payload->>'sub')::uuid;
            
            -- Validate that it's a valid UUID
            IF user_id IS NULL OR user_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
                RETURN NULL;
            END IF;
            
            RETURN user_id;
        END;
        $func$;
    END IF;
END $$;

-- Step 2: Drop existing user policies
DROP POLICY IF EXISTS "Users manage own tokens" ON refresh_tokens;
DROP POLICY IF EXISTS "Users manage own activity" ON user_activity_log;

-- Step 3: Create new RLS policies that work with custom JWT
CREATE POLICY "Users manage own tokens" ON refresh_tokens
    FOR ALL USING (get_current_user_id() = user_id);

CREATE POLICY "Users manage own activity" ON user_activity_log
    FOR ALL USING (get_current_user_id() = user_id);

-- Step 4: Verify the fix
SELECT 'Token tables RLS policies updated for custom JWT' as status;

-- Show the new policies
SELECT 
  tablename,
  policyname,
  permissive,
  cmd,
  qual
FROM pg_policies 
WHERE tablename IN ('refresh_tokens', 'user_activity_log')
ORDER BY tablename, policyname;

SELECT 'Token tables RLS fix completed!' as result;
