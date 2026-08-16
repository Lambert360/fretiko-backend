-- Migration: Add interstate/international delivery configuration to logistics partners
-- Feature: Enhanced Delivery Options — interstate & international delivery support
--
-- interstate_config JSONB shape:
-- {
--   "enabled": boolean,
--   "international_enabled": boolean,
--   "base_price": number,
--   "per_km_rate": number,
--   "international_base_price": number,
--   "international_per_km_rate": number,
--   "estimated_delivery_days_min": number,
--   "estimated_delivery_days_max": number
-- }

ALTER TABLE verified_logistics_partners
  ADD COLUMN IF NOT EXISTS interstate_config JSONB DEFAULT NULL;

COMMENT ON COLUMN verified_logistics_partners.interstate_config IS
  'Interstate/international delivery pricing & config: enabled, international_enabled, base_price, per_km_rate, international_base_price, international_per_km_rate, estimated_delivery_days_min/max';
