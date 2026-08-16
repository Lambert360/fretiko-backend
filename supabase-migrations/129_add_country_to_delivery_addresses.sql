-- Migration 129: Add country column to delivery_addresses
-- Allows storing the buyer's country alongside state for accurate rider location filtering

ALTER TABLE delivery_addresses
  ADD COLUMN IF NOT EXISTS country text;
