-- Migration 128: Add pricing_config column to verified_logistics_partners
-- Root cause fix: this column was defined in the migrations/ track but was
-- never applied to the live Supabase database via supabase-migrations/.
-- Without this column every partner pricing save fails, so all riders fall
-- back to the hardcoded 2 Freti delivery price.

ALTER TABLE verified_logistics_partners
  ADD COLUMN IF NOT EXISTS pricing_config JSONB DEFAULT '{}';

COMMENT ON COLUMN verified_logistics_partners.pricing_config IS
  'Per-vehicle-type base price and per-km rate set by the partner company.
   Keys are normalised vehicle types: wheelbarrow, bike, car, van, truck.
   IMPORTANT: all monetary values MUST be stored in Freti (1 Freti = 1 USD).
   The partner dashboard converts the partner''s local currency → Freti
   via the /wallet/deposit/rate exchange-rate API before saving here.
   findNearbyRiders() in riders.service.ts reads these values and returns
   them directly as Freti prices to the mobile app.
   Structure: { "bike": { "base_price": 0.65, "per_km_rate": 0.065 }, ... }';
