-- Migration: Partner Wallet System
-- Run AFTER: 096_rider_id_system.sql

BEGIN;

-- 1. Partner wallet (one per partner, tracks real-money balance)
CREATE TABLE IF NOT EXISTS partner_wallets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id          UUID REFERENCES verified_logistics_partners(id) ON DELETE CASCADE UNIQUE NOT NULL,
  available_balance   DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  pending_withdrawal  DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  total_earned        DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  total_withdrawn     DECIMAL(18,2) NOT NULL DEFAULT 0.00,
  preferred_currency  VARCHAR(3) NOT NULL DEFAULT 'NGN',
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Partner bank accounts (for withdrawal payouts)
CREATE TABLE IF NOT EXISTS partner_bank_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id     UUID REFERENCES verified_logistics_partners(id) ON DELETE CASCADE NOT NULL,
  account_name   VARCHAR(255) NOT NULL,
  bank_name      VARCHAR(255) NOT NULL,
  bank_code      VARCHAR(50),
  account_number VARCHAR(50) NOT NULL,
  account_type   VARCHAR(20) NOT NULL DEFAULT 'current'
                   CHECK (account_type IN ('savings', 'current', 'checking')),
  currency       VARCHAR(3)  NOT NULL DEFAULT 'NGN',
  country        VARCHAR(2)  NOT NULL DEFAULT 'NG',
  is_default     BOOLEAN NOT NULL DEFAULT FALSE,
  is_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Partner withdrawal requests (audit trail)
CREATE TABLE IF NOT EXISTS partner_withdrawals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id      UUID REFERENCES verified_logistics_partners(id) ON DELETE CASCADE NOT NULL,
  wallet_id       UUID REFERENCES partner_wallets(id) NOT NULL,
  bank_account_id UUID REFERENCES partner_bank_accounts(id),
  amount          DECIMAL(18,2) NOT NULL CHECK (amount > 0),
  currency        VARCHAR(3)  NOT NULL DEFAULT 'NGN',
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  reference       VARCHAR(100),
  notes           TEXT,
  failure_reason  TEXT,
  requested_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  processed_at    TIMESTAMP WITH TIME ZONE,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Indexes
CREATE INDEX IF NOT EXISTS idx_partner_wallets_partner_id     ON partner_wallets(partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_bank_accounts_partner  ON partner_bank_accounts(partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_withdrawals_partner    ON partner_withdrawals(partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_withdrawals_status     ON partner_withdrawals(status);

-- 5. RLS
ALTER TABLE partner_wallets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_bank_accounts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_withdrawals     ENABLE ROW LEVEL SECURITY;

-- Service role gets full access (backend uses service key)
CREATE POLICY partner_wallets_service_all         ON partner_wallets         FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY partner_bank_accounts_service_all   ON partner_bank_accounts   FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY partner_withdrawals_service_all     ON partner_withdrawals     FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 6. Seed wallets for all existing active partners
INSERT INTO partner_wallets (partner_id, preferred_currency)
SELECT
  vlp.id,
  COALESCE(vlp.preferred_currency, 'NGN')
FROM verified_logistics_partners vlp
WHERE NOT EXISTS (
  SELECT 1 FROM partner_wallets pw WHERE pw.partner_id = vlp.id
);

COMMIT;
