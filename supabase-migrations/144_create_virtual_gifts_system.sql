BEGIN;

-- =====================================================
-- CREATE VIRTUAL GIFTS SYSTEM
-- Migration: 144
-- Date: 2025-01-20
-- Description: Virtual gift economy for calls, streams, and auctions
-- Includes gift types, user ownership, transactions, and admin wallet
-- =====================================================

-- Create virtual_gifts table (gift catalog)
CREATE TABLE IF NOT EXISTS virtual_gifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  emoji VARCHAR(10) NOT NULL,
  credit_value INTEGER NOT NULL CHECK (credit_value > 0),
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create user_gifts table (user gift ownership)
CREATE TABLE IF NOT EXISTS user_gifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gift_id UUID NOT NULL REFERENCES virtual_gifts(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  source VARCHAR(50) NOT NULL CHECK (source IN ('purchased', 'received_call', 'received_stream', 'received_auction')),
  received_from UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id UUID, -- Call/stream/auction session reference
  received_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Ensure no duplicate entries for same gift from same source
  UNIQUE(user_id, gift_id, source, received_from, session_id)
);

-- Create gift_transactions table (audit trail)
CREATE TABLE IF NOT EXISTS gift_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  gift_id UUID NOT NULL REFERENCES virtual_gifts(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  transaction_type VARCHAR(50) NOT NULL CHECK (transaction_type IN ('purchase', 'convert', 'send', 'receive')),
  credit_amount INTEGER, -- For purchases/conversions
  recipient_id UUID REFERENCES auth.users(id) ON DELETE SET NULL, -- For sends
  session_type VARCHAR(50) CHECK (session_type IN ('call', 'stream', 'auction')),
  session_id UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_virtual_gifts_active ON virtual_gifts(is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_user_gifts_user_id ON user_gifts(user_id);
CREATE INDEX IF NOT EXISTS idx_user_gifts_gift_id ON user_gifts(gift_id);
CREATE INDEX IF NOT EXISTS idx_user_gifts_user_gift ON user_gifts(user_id, gift_id);
CREATE INDEX IF NOT EXISTS idx_user_gifts_source ON user_gifts(source);
CREATE INDEX IF NOT EXISTS idx_gift_transactions_user_id ON gift_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_gift_transactions_type ON gift_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_gift_transactions_created_at ON gift_transactions(created_at);

-- Add RLS policies for virtual_gifts (public read, admin write)
ALTER TABLE virtual_gifts ENABLE ROW LEVEL SECURITY;

-- Policy: Anyone can read active gifts
CREATE POLICY "virtual_gifts_read_active" ON virtual_gifts
  FOR SELECT
  USING (is_active = true OR auth.role() = 'service_role');

-- Policy: Service role can manage all gifts
CREATE POLICY "virtual_gifts_service_role_admin" ON virtual_gifts
  FOR ALL
  USING (auth.role() = 'service_role');

-- Add RLS policies for user_gifts
ALTER TABLE user_gifts ENABLE ROW LEVEL SECURITY;

-- Policy: Users can read their own gifts
CREATE POLICY "user_gifts_read_own" ON user_gifts
  FOR SELECT
  USING (auth.uid() = user_id);

-- Policy: Service role can manage all user gifts
CREATE POLICY "user_gifts_service_role_admin" ON user_gifts
  FOR ALL
  USING (auth.role() = 'service_role');

-- Add RLS policies for gift_transactions
ALTER TABLE gift_transactions ENABLE ROW LEVEL SECURITY;

-- Policy: Users can read their own transactions
CREATE POLICY "gift_transactions_read_own" ON gift_transactions
  FOR SELECT
  USING (auth.uid() = user_id OR auth.uid() = recipient_id);

-- Policy: Service role can manage all transactions
CREATE POLICY "gift_transactions_service_role_admin" ON gift_transactions
  FOR ALL
  USING (auth.role() = 'service_role');

-- Create function to update updated_at timestamp for virtual_gifts
CREATE OR REPLACE FUNCTION update_virtual_gifts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for updated_at
CREATE TRIGGER virtual_gifts_updated_at_trigger
  BEFORE UPDATE ON virtual_gifts
  FOR EACH ROW
  EXECUTE FUNCTION update_virtual_gifts_updated_at();

-- Seed initial gift types
INSERT INTO virtual_gifts (name, emoji, credit_value, sort_order) VALUES
  ('Heart', '💝', 5, 1),
  ('Rose', '🌹', 10, 2),
  ('Star', '⭐', 15, 3),
  ('Celebration', '🎉', 25, 4),
  ('Diamond', '💎', 50, 5),
  ('Rocket', '🚀', 100, 6)
ON CONFLICT DO NOTHING;

-- Ensure admin gift wallet user exists in auth.users
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = '00000000-0000-4000-8000-000000000003') THEN
    INSERT INTO auth.users (
      id,
      email,
      encrypted_password,
      email_confirmed_at,
      created_at,
      updated_at,
      raw_app_meta_data,
      raw_user_meta_data,
      is_super_admin,
      role
    ) VALUES (
      '00000000-0000-4000-8000-000000000003',
      'platform_gift_wallet@fretiko.internal',
      crypt(gen_random_uuid()::text, gen_salt('bf')),
      NOW(),
      NOW(),
      NOW(),
      '{"provider": "email", "providers": ["email"]}',
      '{"name": "Platform Gift Wallet", "is_system": true}',
      false,
      'authenticated'
    );
  END IF;
END $$;

-- Ensure admin gift wallet user exists in user_profiles
-- Use minimal required fields to avoid column mismatch errors
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM user_profiles WHERE id = '00000000-0000-4000-8000-000000000003') THEN
    INSERT INTO user_profiles (id, created_at, updated_at)
    VALUES (
      '00000000-0000-4000-8000-000000000003',
      NOW(),
      NOW()
    );
  END IF;
END $$;

-- Ensure admin gift wallet exists (separate from platform wallet)
-- Admin gift wallet ID: 00000000-0000-4000-8000-000000000003
INSERT INTO wallets (
  user_id,
  available_balance,
  escrow_balance,
  pending_withdrawal,
  preferred_currency,
  kyc_status,
  daily_deposit_limit,
  daily_withdrawal_limit
) VALUES (
  '00000000-0000-4000-8000-000000000003',
  0.0,
  0.0,
  0.0,
  'USD',
  'approved',
  999999999.0,
  999999999.0
) ON CONFLICT (user_id) DO NOTHING;

COMMIT;

