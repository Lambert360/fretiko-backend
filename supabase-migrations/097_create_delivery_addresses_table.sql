-- Migration: Create delivery_addresses table for address book management
-- Description: Allows users to save multiple delivery addresses and set a default one

-- Create delivery_addresses table
CREATE TABLE IF NOT EXISTS public.delivery_addresses (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  
  -- Address fields
  full_name text NOT NULL,
  phone text NOT NULL,
  address text NOT NULL,
  city text NOT NULL,
  state text NOT NULL,
  postal_code text,
  
  -- Default flag
  is_default boolean DEFAULT FALSE,
  
  -- Timestamps
  created_at timestamp with time zone DEFAULT NOW(),
  updated_at timestamp with time zone DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_delivery_addresses_user_id ON public.delivery_addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_delivery_addresses_is_default ON public.delivery_addresses(user_id, is_default) WHERE is_default = TRUE;

-- Enable RLS
ALTER TABLE public.delivery_addresses ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own addresses" ON public.delivery_addresses
FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own addresses" ON public.delivery_addresses
FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own addresses" ON public.delivery_addresses
FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own addresses" ON public.delivery_addresses
FOR DELETE USING (auth.uid() = user_id);

-- Add comments
COMMENT ON TABLE public.delivery_addresses IS 'Stores user delivery addresses for checkout';
COMMENT ON COLUMN public.delivery_addresses.full_name IS 'Recipient full name';
COMMENT ON COLUMN public.delivery_addresses.phone IS 'Contact phone number';
COMMENT ON COLUMN public.delivery_addresses.is_default IS 'Whether this is the default address for the user';

-- Create trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_delivery_addresses_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_delivery_addresses_updated_at
BEFORE UPDATE ON public.delivery_addresses
FOR EACH ROW
EXECUTE FUNCTION update_delivery_addresses_updated_at();

-- Display summary
DO $$
BEGIN
  RAISE NOTICE '✅ delivery_addresses table created successfully';
  RAISE NOTICE '✅ Indexes created';
  RAISE NOTICE '✅ RLS policies enabled';
  RAISE NOTICE '✅ Trigger for updated_at created';
END $$;

