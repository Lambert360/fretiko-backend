-- Migration: Add booking type to services
-- Created: 2025-09-03

-- Create booking type enum
CREATE TYPE service_booking_type AS ENUM ('add_to_cart', 'book_now');

-- Add booking_type column to services table
ALTER TABLE services 
ADD COLUMN booking_type service_booking_type DEFAULT 'add_to_cart';

-- Add index for booking type queries
CREATE INDEX idx_services_booking_type ON services(booking_type);

-- Update existing services to have default booking type
UPDATE services SET booking_type = 'add_to_cart' WHERE booking_type IS NULL;

-- Make booking_type NOT NULL
ALTER TABLE services ALTER COLUMN booking_type SET NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN services.booking_type IS 'Determines how customers can purchase this service: add_to_cart (direct add) or book_now (with scheduling)';