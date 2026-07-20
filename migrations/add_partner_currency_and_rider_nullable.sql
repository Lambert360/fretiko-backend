-- Migration: Partner currency preference + partner-submitted riders support
-- Run this in your Supabase SQL editor

-- 1. Add preferred_currency to verified_logistics_partners
ALTER TABLE verified_logistics_partners
  ADD COLUMN IF NOT EXISTS preferred_currency VARCHAR(10) DEFAULT 'NGN';

-- 2. Allow partner-submitted rider applications (user_id can be NULL when partner adds the rider)
--    PostgreSQL UNIQUE treats NULLs as distinct so multiple partner-submitted riders are fine.
ALTER TABLE rider_verification_requests
  ALTER COLUMN user_id DROP NOT NULL;

-- 3. Track which partner submitted the request (for partner-initiated additions)
ALTER TABLE rider_verification_requests
  ADD COLUMN IF NOT EXISTS submitted_by_partner_id UUID REFERENCES verified_logistics_partners(id);

-- Grant permissions
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
