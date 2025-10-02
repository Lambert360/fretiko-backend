-- Simple role system: citizen, rider, vendor
-- Run this in Supabase SQL Editor when it's back online

-- 1. Add role column to user_profiles
ALTER TABLE public.user_profiles 
ADD COLUMN user_role TEXT DEFAULT 'citizen' CHECK (user_role IN ('citizen', 'rider', 'vendor'));

-- 2. Add index for role queries
CREATE INDEX IF NOT EXISTS user_profiles_user_role_idx ON public.user_profiles(user_role);

-- 3. Update handle_new_user function to include role
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.user_profiles (id, username, user_role)
    VALUES (
        NEW.id,
        COALESCE(
            NEW.raw_user_meta_data->>'username',
            LOWER(SPLIT_PART(NEW.email, '@', 1))
        ),
        COALESCE(NEW.raw_user_meta_data->>'user_role', 'citizen')
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Migrate existing users (set vendors based on is_seller)
UPDATE user_profiles 
SET user_role = 'vendor' 
WHERE is_seller = true;

COMMIT;