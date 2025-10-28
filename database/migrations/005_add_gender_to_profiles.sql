-- Migration: Add gender column to user_profiles
-- Run this in Supabase SQL Editor

-- 1. Add gender column
ALTER TABLE public.user_profiles
ADD COLUMN IF NOT EXISTS gender TEXT CHECK (gender IN ('male', 'female', 'other', 'prefer_not_to_say'));

-- 2. Create index for gender queries (optional but good for analytics)
CREATE INDEX IF NOT EXISTS user_profiles_gender_idx ON public.user_profiles(gender);

-- 3. Update handle_new_user function to include gender
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.user_profiles (id, username, user_role, gender)
    VALUES (
        NEW.id,
        COALESCE(
            NEW.raw_user_meta_data->>'username',
            LOWER(SPLIT_PART(NEW.email, '@', 1))
        ),
        COALESCE(NEW.raw_user_meta_data->>'user_role', 'citizen'),
        NEW.raw_user_meta_data->>'gender'
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMIT;
