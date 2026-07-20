-- Migration: Add missing profile columns to verified_logistics_partners
-- Fixes profile update errors caused by columns not existing in the table.

ALTER TABLE verified_logistics_partners
  ADD COLUMN IF NOT EXISTS preferred_currency VARCHAR(10) DEFAULT 'NGN',
  ADD COLUMN IF NOT EXISTS company_website VARCHAR(500),
  ADD COLUMN IF NOT EXISTS contact_person_name VARCHAR(255);
