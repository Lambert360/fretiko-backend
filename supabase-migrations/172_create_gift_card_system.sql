-- =====================================================
-- CREATE GIFT CARD SYSTEM
-- Migration: 172
-- Date: 2026-08-13
-- Description: Store credit gift card system with FRETI currency,
--              custom amounts, optional recipients, chat/email delivery,
--              username security, and escrow integration
-- =====================================================

BEGIN;

-- =====================================================
-- GIFT CARD DESIGNS
-- =====================================================
CREATE TABLE IF NOT EXISTS gift_card_designs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  design_url VARCHAR(255) NOT NULL,
  preview_url VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- GIFT CARDS
-- =====================================================
CREATE TABLE IF NOT EXISTS gift_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_number VARCHAR(16) UNIQUE NOT NULL,
  pin VARCHAR(4) NOT NULL,
  
  -- Design and value
  design_id UUID REFERENCES gift_card_designs(id) ON DELETE SET NULL,
  initial_balance DECIMAL(18,6) NOT NULL,
  current_balance DECIMAL(18,6) NOT NULL,
  
  -- Lifecycle
  status VARCHAR(20) DEFAULT 'active' 
    CHECK (status IN ('active', 'claimed', 'redeemed', 'expired', 'blocked')),
  
  -- Ownership (Optional recipients)
  purchaser_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  
  -- Recipient information (ALL OPTIONAL - if NULL, card is for purchaser)
  recipient_username VARCHAR(100),
  recipient_user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  recipient_email VARCHAR(255),
  recipient_phone VARCHAR(20),
  
  -- Delivery tracking
  delivery_method VARCHAR(20) CHECK (delivery_method IN ('none', 'email', 'chat', 'both')),
  email_sent_at TIMESTAMP WITH TIME ZONE,
  email_sent_to VARCHAR(255),
  chat_message_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
  chat_sent_at TIMESTAMP WITH TIME ZONE,
  
  -- Claim tracking
  claimed_at TIMESTAMP WITH TIME ZONE,
  claim_code VARCHAR(20) UNIQUE,
  
  -- Timing
  purchased_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE,
  last_used_at TIMESTAMP WITH TIME ZONE,
  
  -- Security
  purchase_ip VARCHAR(45),
  redemption_attempts INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  
  -- Admin creation tracking (for competitions, promotions, customer service)
  created_by UUID REFERENCES staff_accounts(id) ON DELETE SET NULL,
  source VARCHAR(20) DEFAULT 'user_purchase' 
    CHECK (source IN ('user_purchase', 'admin_created')),
  creation_reason VARCHAR(255),
  is_commercial BOOLEAN DEFAULT false,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- GIFT CARD TRANSACTIONS
-- =====================================================
CREATE TABLE IF NOT EXISTS gift_card_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_card_id UUID REFERENCES gift_cards(id) ON DELETE CASCADE,
  transaction_type VARCHAR(30) NOT NULL 
    CHECK (transaction_type IN ('purchase', 'claim', 'redeem', 'partial_redeem', 'expire', 'block', 'admin_adjust')),
  
  amount DECIMAL(18,6),
  balance_after DECIMAL(18,6),
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  
  -- User context
  user_id UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  user_ip VARCHAR(45),
  
  -- Additional context
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- GIFT CARD SUGGESTED AMOUNTS
-- =====================================================
CREATE TABLE IF NOT EXISTS gift_card_suggested_amounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  amount DECIMAL(18,6) NOT NULL,
  display_name VARCHAR(50) NOT NULL,
  is_popular BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- INDEXES
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_gift_cards_card_number ON gift_cards(card_number);
CREATE INDEX IF NOT EXISTS idx_gift_cards_pin ON gift_cards(pin);
CREATE INDEX IF NOT EXISTS idx_gift_cards_purchaser_id ON gift_cards(purchaser_id);
CREATE INDEX IF NOT EXISTS idx_gift_cards_recipient_user_id ON gift_cards(recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_gift_cards_recipient_username ON gift_cards(recipient_username);
CREATE INDEX IF NOT EXISTS idx_gift_cards_claim_code ON gift_cards(claim_code);
CREATE INDEX IF NOT EXISTS idx_gift_cards_status ON gift_cards(status);
CREATE INDEX IF NOT EXISTS idx_gift_cards_expires_at ON gift_cards(expires_at);
CREATE INDEX IF NOT EXISTS idx_gift_cards_design_id ON gift_cards(design_id);
CREATE INDEX IF NOT EXISTS idx_gift_cards_created_by ON gift_cards(created_by);
CREATE INDEX IF NOT EXISTS idx_gift_cards_source ON gift_cards(source);
CREATE INDEX IF NOT EXISTS idx_gift_cards_is_commercial ON gift_cards(is_commercial);

CREATE INDEX IF NOT EXISTS idx_gift_card_transactions_gift_card_id ON gift_card_transactions(gift_card_id);
CREATE INDEX IF NOT EXISTS idx_gift_card_transactions_order_id ON gift_card_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_gift_card_transactions_user_id ON gift_card_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_gift_card_transactions_type ON gift_card_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_gift_card_transactions_created_at ON gift_card_transactions(created_at);

-- =====================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================
ALTER TABLE gift_cards ENABLE ROW LEVEL SECURITY;

-- Users can view their own purchased gift cards
CREATE POLICY "users_view_own_purchased_cards" ON gift_cards
FOR SELECT USING (purchaser_id = auth.uid());

-- Users can view gift cards sent to them
CREATE POLICY "users_view_received_cards" ON gift_cards
FOR SELECT USING (recipient_user_id = auth.uid());

-- Service role full access
CREATE POLICY "service_role_full_access" ON gift_cards
FOR ALL TO service_role USING (true);

ALTER TABLE gift_card_transactions ENABLE ROW LEVEL SECURITY;

-- Users can view their own gift card transactions
CREATE POLICY "users_view_own_transactions" ON gift_card_transactions
FOR SELECT USING (user_id = auth.uid());

-- Service role full access
CREATE POLICY "service_role_full_access_transactions" ON gift_card_transactions
FOR ALL TO service_role USING (true);

-- =====================================================
-- EXISTING TABLE MODIFICATIONS
-- =====================================================

-- Add to orders table
ALTER TABLE orders 
ADD COLUMN IF NOT EXISTS gift_card_applied_amount DECIMAL(18,6) DEFAULT 0,
ADD COLUMN IF NOT EXISTS gift_card_transaction_id UUID REFERENCES gift_card_transactions(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS payment_source VARCHAR(20) 
  CHECK (payment_source IN ('wallet', 'gift_card', 'mixed'));

-- Add to escrows table
ALTER TABLE escrows 
ADD COLUMN IF NOT EXISTS payment_source VARCHAR(20) 
  CHECK (payment_source IN ('wallet', 'gift_card', 'mixed')),
ADD COLUMN IF NOT EXISTS gift_card_amount DECIMAL(18,6) DEFAULT 0;

-- =====================================================
-- FUNCTIONS
-- =====================================================

-- Generate secure 16-digit card number
CREATE OR REPLACE FUNCTION generate_gift_card_number()
RETURNS VARCHAR(16) AS $$
DECLARE
    v_number VARCHAR(16);
    v_exists INTEGER;
BEGIN
    LOOP
        -- Generate 16 random digits
        v_number := '';
        FOR i IN 1..16 LOOP
            v_number := v_number || FLOOR(RANDOM() * 10)::TEXT;
        END LOOP;
        
        -- Check if unique
        SELECT COUNT(*) INTO v_exists 
        FROM gift_cards 
        WHERE card_number = v_number;
        
        EXIT WHEN v_exists = 0;
    END LOOP;
    
    RETURN v_number;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Generate 4-digit PIN
CREATE OR REPLACE FUNCTION generate_gift_card_pin()
RETURNS VARCHAR(4) AS $$
BEGIN
    RETURN LPAD(FLOOR(RANDOM() * 10000)::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Generate unique claim code
CREATE OR REPLACE FUNCTION generate_claim_code()
RETURNS VARCHAR(20) AS $$
DECLARE
    v_code VARCHAR(20);
    v_exists INTEGER;
    v_chars VARCHAR := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
BEGIN
    LOOP
        v_code := '';
        FOR i IN 1..16 LOOP
            v_code := v_code || SUBSTRING(v_chars, FLOOR(RANDOM() * LENGTH(v_chars) + 1)::INTEGER, 1);
        END LOOP;
        
        SELECT COUNT(*) INTO v_exists 
        FROM gift_cards 
        WHERE claim_code = v_code;
        
        EXIT WHEN v_exists = 0;
    END LOOP;
    
    RETURN v_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- TRIGGERS
-- =====================================================

-- Auto-generate card number, PIN, and claim code on insert
CREATE OR REPLACE FUNCTION set_gift_card_defaults()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.card_number IS NULL THEN
        NEW.card_number := generate_gift_card_number();
    END IF;
    IF NEW.pin IS NULL THEN
        NEW.pin := generate_gift_card_pin();
    END IF;
    IF NEW.claim_code IS NULL THEN
        NEW.claim_code := generate_claim_code();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gift_card_defaults_trigger
BEFORE INSERT ON gift_cards
FOR EACH ROW EXECUTE FUNCTION set_gift_card_defaults();

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_gift_card_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gift_card_updated_at_trigger
BEFORE UPDATE ON gift_cards
FOR EACH ROW EXECUTE FUNCTION update_gift_card_updated_at();

-- Increment redemption attempts atomically
CREATE OR REPLACE FUNCTION increment_redemption_attempts(p_card_number VARCHAR)
RETURNS INTEGER AS $$
DECLARE
    v_attempts INTEGER;
BEGIN
    UPDATE gift_cards
    SET redemption_attempts = redemption_attempts + 1
    WHERE card_number = p_card_number
    RETURNING redemption_attempts INTO v_attempts;
    
    RETURN v_attempts;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- TRANSACTION TYPES FOR ADMIN CREATION
-- =====================================================
-- 'admin_adjust' transaction type is already included in the CHECK constraint
-- This allows tracking of admin modifications to gift card balances
-- =====================================================

-- =====================================================
-- SEED DATA
-- =====================================================

-- Default gift card designs
INSERT INTO gift_card_designs (name, design_url, preview_url, sort_order) VALUES
('Birthday', 'https://cdn.fretiko.com/gift-cards/birthday.png', 'https://cdn.fretiko.com/gift-cards/birthday-thumb.png', 1),
('Thank You', 'https://cdn.fretiko.com/gift-cards/thank-you.png', 'https://cdn.fretiko.com/gift-cards/thank-you-thumb.png', 2),
('Congratulations', 'https://cdn.fretiko.com/gift-cards/congratulations.png', 'https://cdn.fretiko.com/gift-cards/congratulations-thumb.png', 3),
('General', 'https://cdn.fretiko.com/gift-cards/general.png', 'https://cdn.fretiko.com/gift-cards/general-thumb.png', 4)
ON CONFLICT DO NOTHING;

-- Suggested amounts
INSERT INTO gift_card_suggested_amounts (amount, display_name, is_popular, sort_order) VALUES
(5.00, '5 FRETI', false, 1),
(10.00, '10 FRETI', true, 2),
(25.00, '25 FRETI', true, 3),
(50.00, '50 FRETI', true, 4),
(100.00, '100 FRETI', false, 5)
ON CONFLICT DO NOTHING;

-- =====================================================
-- COMMENTS
-- =====================================================

COMMENT ON TABLE gift_card_designs IS 'Visual templates for gift cards';
COMMENT ON TABLE gift_cards IS 'Individual gift cards with balances and recipient information';
COMMENT ON TABLE gift_card_transactions IS 'Audit trail for all gift card operations';
COMMENT ON TABLE gift_card_suggested_amounts IS 'Suggested amounts for UI display (not enforced)';

COMMENT ON COLUMN gift_cards.card_number IS '16-digit unique card number';
COMMENT ON COLUMN gift_cards.pin IS '4-digit PIN for redemption';
COMMENT ON COLUMN gift_cards.recipient_username IS 'Username for security validation (optional)';
COMMENT ON COLUMN gift_cards.delivery_method IS 'How the gift card was delivered: none, email, chat, or both';
COMMENT ON COLUMN gift_cards.claim_code IS 'Unique code for email/chat claim links';
COMMENT ON COLUMN gift_cards.created_by IS 'Admin staff member who created the card (if admin_created)';
COMMENT ON COLUMN gift_cards.source IS 'Card source: user_purchase (wallet debited) or admin_created (platform budget)';
COMMENT ON COLUMN gift_cards.creation_reason IS 'Reason for admin creation (competition, compensation, promotion, etc.)';
COMMENT ON COLUMN gift_cards.is_commercial IS 'Whether this is for business/commercial use vs personal gifts';

COMMENT ON COLUMN orders.gift_card_applied_amount IS 'Amount from gift card applied to this order';
COMMENT ON COLUMN orders.payment_source IS 'Payment source: wallet, gift_card, or mixed';
COMMENT ON COLUMN escrows.payment_source IS 'Payment source for escrow tracking';
COMMENT ON COLUMN escrows.gift_card_amount IS 'Portion of escrow funded by gift card';

-- =====================================================
-- ADMIN CREATION TRACKING
-- =====================================================
-- The following fields enable admin-created gift cards for:
-- - Competitions and contests
-- - Marketing campaigns and giveaways
-- - Customer service compensation
-- - Loyalty program rewards
-- - Special events and celebrations
-- - Internal testing
--
-- created_by: References staff table for audit trail
-- source: Distinguishes user_purchased vs admin_created cards
-- creation_reason: Mandatory for admin-created cards
-- is_commercial: For business use tracking
-- =====================================================

COMMIT;
