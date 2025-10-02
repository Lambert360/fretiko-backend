-- Fix Database Tables for Supabase Auth Issue
-- This fixes the "Database error saving new user" by creating missing tables and updating triggers

-- 1. First, check if user_profiles table exists and has correct structure
-- Add missing columns if they don't exist
DO $$
BEGIN
    -- Add user_role column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='user_profiles' AND column_name='user_role') THEN
        ALTER TABLE public.user_profiles
        ADD COLUMN user_role TEXT DEFAULT 'citizen' CHECK (user_role IN ('citizen', 'rider', 'vendor'));

        CREATE INDEX IF NOT EXISTS user_profiles_user_role_idx ON public.user_profiles(user_role);
    END IF;

    -- Add is_rider column if it doesn't exist (as you manually added)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='user_profiles' AND column_name='is_rider') THEN
        ALTER TABLE public.user_profiles
        ADD COLUMN is_rider BOOLEAN DEFAULT FALSE;

        CREATE INDEX IF NOT EXISTS user_profiles_is_rider_idx ON public.user_profiles(is_rider);
    END IF;
END $$;

-- 2. Create rewards_balances table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.rewards_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,

    -- Rewards balance (in Freti equivalent, but displayed as ⭐ points)
    available_rewards DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    pending_rewards DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    lifetime_earned DECIMAL(18,6) NOT NULL DEFAULT 0.000000,
    lifetime_spent DECIMAL(18,6) NOT NULL DEFAULT 0.000000,

    -- Last calculation period
    last_calculation_period VARCHAR(7), -- Format: 2025-08 (year-month)
    last_calculated_at TIMESTAMP WITH TIME ZONE,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(user_id)
);

-- 3. Enable RLS on rewards_balances
ALTER TABLE public.rewards_balances ENABLE ROW LEVEL SECURITY;

-- 4. Create RLS policies for rewards_balances (drop existing first to avoid conflicts)
DROP POLICY IF EXISTS "Users can view own rewards balance" ON public.rewards_balances;
DROP POLICY IF EXISTS "Users can update own rewards balance" ON public.rewards_balances;

CREATE POLICY "Users can view own rewards balance" ON public.rewards_balances
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own rewards balance" ON public.rewards_balances
    FOR UPDATE USING (auth.uid() = user_id);

-- 5. Create indexes for rewards_balances
CREATE INDEX IF NOT EXISTS idx_rewards_balances_user_id ON public.rewards_balances(user_id);

-- 6. Create or replace the updated_at function if it doesn't exist
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 7. Create updated_at trigger for rewards_balances
DROP TRIGGER IF EXISTS update_rewards_balances_updated_at ON public.rewards_balances;
CREATE TRIGGER update_rewards_balances_updated_at
    BEFORE UPDATE ON public.rewards_balances
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 8. Create function to create rewards balance for new users
CREATE OR REPLACE FUNCTION public.create_user_rewards_balance()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.rewards_balances (user_id) VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 9. Create trigger to create rewards balance for new users
DROP TRIGGER IF EXISTS create_user_rewards_balance_trigger ON public.user_profiles;
CREATE TRIGGER create_user_rewards_balance_trigger
    AFTER INSERT ON public.user_profiles
    FOR EACH ROW EXECUTE FUNCTION public.create_user_rewards_balance();

-- 10. Update the handle_new_user function to match the current user_profiles structure
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

-- 11. Ensure the auth user trigger exists
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 12. Create rewards balances for any existing user profiles
INSERT INTO public.rewards_balances (user_id)
SELECT id FROM public.user_profiles
WHERE NOT EXISTS (
    SELECT 1 FROM public.rewards_balances
    WHERE rewards_balances.user_id = user_profiles.id
)
ON CONFLICT (user_id) DO NOTHING;

-- 13. Grant necessary permissions
GRANT SELECT, UPDATE ON public.rewards_balances TO authenticated;
GRANT ALL ON public.rewards_balances TO service_role;

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'Database tables and triggers have been created/updated successfully!';
    RAISE NOTICE 'You should now be able to create users without "Database error saving new user"';
END $$;