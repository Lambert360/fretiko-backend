-- FIX CART RLS POLICIES FOR CUSTOM JWT AUTHENTICATION
-- This migration fixes the cart_items table to work with custom JWT tokens
-- Instead of using auth.uid(), we'll use a custom function that extracts user ID from JWT

-- Step 1: Create a function to extract user ID from custom JWT token
CREATE OR REPLACE FUNCTION get_current_user_id()
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    auth_header TEXT;
    token TEXT;
    payload TEXT;
    decoded_payload JSONB;
    user_id UUID;
BEGIN
    -- Get the Authorization header from the current request
    -- Note: This works because PostgREST passes headers to the database
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
$$;

-- Step 2: Drop existing cart_items RLS policies
DROP POLICY IF EXISTS "Users can view their own cart items" ON cart_items;
DROP POLICY IF EXISTS "Users can add to their own cart" ON cart_items;
DROP POLICY IF EXISTS "Users can update their own cart items" ON cart_items;
DROP POLICY IF EXISTS "Users can delete their own cart items" ON cart_items;

-- Step 3: Create new RLS policies that work with custom JWT
CREATE POLICY "Users can view their own cart items" ON cart_items
    FOR SELECT USING (get_current_user_id() = user_id);

CREATE POLICY "Users can add to their own cart" ON cart_items
    FOR INSERT WITH CHECK (get_current_user_id() = user_id);

CREATE POLICY "Users can update their own cart items" ON cart_items
    FOR UPDATE USING (get_current_user_id() = user_id) 
    WITH CHECK (get_current_user_id() = user_id);

CREATE POLICY "Users can delete their own cart items" ON cart_items
    FOR DELETE USING (get_current_user_id() = user_id);

-- Step 4: Verify the fix
SELECT 'Cart RLS policies updated for custom JWT' as status;

-- Show the new policies
SELECT 
  tablename,
  policyname,
  permissive,
  cmd,
  qual,
  with_check
FROM pg_policies 
WHERE tablename = 'cart_items'
ORDER BY policyname;

SELECT 'Cart RLS fix completed!' as result;
