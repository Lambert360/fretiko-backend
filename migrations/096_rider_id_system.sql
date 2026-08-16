-- Migration: Robust rider ID system
-- Run AFTER: 095_create_logistics_partner_tables.sql and add_partner_currency_and_rider_nullable.sql

-- 1. Make user_id nullable in verified_riders (dormant riders have no user account yet)
ALTER TABLE verified_riders ALTER COLUMN user_id DROP NOT NULL;

-- 2. Add unique_rider_id for partner-issued rider codes (e.g. uncutltd0001)
ALTER TABLE verified_riders
  ADD COLUMN IF NOT EXISTS unique_rider_id VARCHAR(50) UNIQUE;

-- 3. Add driver license (uploaded by partner during rider creation)
ALTER TABLE verified_riders
  ADD COLUMN IF NOT EXISTS driver_license_url TEXT;

-- 4. Add location fields (entered by partner, validated on claim)
ALTER TABLE verified_riders
  ADD COLUMN IF NOT EXISTS country VARCHAR(100);
ALTER TABLE verified_riders
  ADD COLUMN IF NOT EXISTS state VARCHAR(100);
ALTER TABLE verified_riders
  ADD COLUMN IF NOT EXISTS city VARCHAR(100);

-- 5. Add extra vehicle fields (partner-provided at creation time)
ALTER TABLE verified_riders
  ADD COLUMN IF NOT EXISTS vehicle_make VARCHAR(100);
ALTER TABLE verified_riders
  ADD COLUMN IF NOT EXISTS vehicle_model VARCHAR(100);
ALTER TABLE verified_riders
  ADD COLUMN IF NOT EXISTS vehicle_year INTEGER;
ALTER TABLE verified_riders
  ADD COLUMN IF NOT EXISTS license_plate VARCHAR(50);
ALTER TABLE verified_riders
  ADD COLUMN IF NOT EXISTS years_experience INTEGER;

-- 6. Track when a rider claimed their dormant account
ALTER TABLE verified_riders
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP WITH TIME ZONE;

-- 7. Add 'dormant' to the verification_status check constraint
ALTER TABLE verified_riders
  DROP CONSTRAINT IF EXISTS verified_riders_verification_status_check;
ALTER TABLE verified_riders
  ADD CONSTRAINT verified_riders_verification_status_check
  CHECK (verification_status IN ('dormant', 'active', 'suspended', 'terminated'));

-- 8. Set default to 'dormant' for new partner-created records
ALTER TABLE verified_riders
  ALTER COLUMN verification_status SET DEFAULT 'dormant';

-- 9. Indexes
CREATE INDEX IF NOT EXISTS idx_verified_riders_unique_rider_id ON verified_riders(unique_rider_id);
CREATE INDEX IF NOT EXISTS idx_verified_riders_company_status ON verified_riders(company_id, verification_status);
CREATE INDEX IF NOT EXISTS idx_verified_riders_claimed ON verified_riders(user_id) WHERE user_id IS NOT NULL;

-- 10. RLS: dormant riders must NOT be visible to authenticated users during checkout
--     The existing policy already filters by verification_status = 'active', so dormant is excluded.
--     Confirm policy is correct (drop and recreate to be safe):
DROP POLICY IF EXISTS verified_riders_public_select ON verified_riders;
CREATE POLICY verified_riders_public_select ON verified_riders
  FOR SELECT TO authenticated
  USING (verification_status = 'active' AND user_id IS NOT NULL);

-- 11. Service role keeps full access (already granted, but ensure it)
DROP POLICY IF EXISTS verified_riders_service_all ON verified_riders;
CREATE POLICY verified_riders_service_all ON verified_riders
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- 12. Partner pricing config: rates per vehicle type
--     Structure: { "bike": { "base_price": 500, "per_km_rate": 50 }, "car": { ... }, ... }
ALTER TABLE verified_logistics_partners
  ADD COLUMN IF NOT EXISTS pricing_config JSONB DEFAULT '{}';

-- Phase 8: Data Backfill
-- Existing admin-verified riders (user_id IS NOT NULL) must stay 'active'.
-- The DEFAULT change above only affects new inserts, but run this explicitly as a safety net.
UPDATE verified_riders
  SET verification_status = 'active'
  WHERE user_id IS NOT NULL
    AND verification_status NOT IN ('suspended', 'terminated');

-- unique_rider_id is NULL for grandfathered riders — this is intentional.
-- They were verified through the admin flow and do not need a claim code.

-- Ensure rider_profiles for any grandfathered riders stay active (no-op if already correct).
UPDATE rider_profiles rp
  SET profile_status = 'active'
  FROM verified_riders vr
  WHERE rp.user_id = vr.user_id
    AND vr.verification_status = 'active'
    AND rp.profile_status != 'active';

COMMIT;
