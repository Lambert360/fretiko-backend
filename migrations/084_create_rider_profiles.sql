-- Migration: Create rider_profiles table
-- Date: 2025-10-26
-- Description: Comprehensive rider profile system for vehicle info, service pricing, and availability

-- Create rider_profiles table
CREATE TABLE IF NOT EXISTS rider_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Vehicle Information
    vehicle_type VARCHAR(20) NOT NULL CHECK (vehicle_type IN ('wheelbarrow', 'bike', 'car', 'van', 'truck')),
    vehicle_make VARCHAR(100),
    vehicle_model VARCHAR(100),
    vehicle_year INTEGER CHECK (vehicle_year >= 1900 AND vehicle_year <= 2100),
    vehicle_color VARCHAR(50),
    license_plate VARCHAR(50),
    vehicle_capacity_weight DECIMAL(10,2) CHECK (vehicle_capacity_weight > 0), -- in kg
    vehicle_capacity_volume DECIMAL(10,2) CHECK (vehicle_capacity_volume > 0), -- in cubic meters
    vehicle_photos TEXT[] DEFAULT '{}',
    vehicle_condition VARCHAR(20) DEFAULT 'good' CHECK (vehicle_condition IN ('excellent', 'good', 'fair')),
    
    -- Service Categories & Pricing (JSONB for flexibility)
    service_pricing JSONB DEFAULT '{
        "intracity": {"enabled": true, "base_price": 2.00, "per_km_rate": 0.50},
        "intercity": {"enabled": true, "base_price": 5.00, "per_km_rate": 1.00},
        "interstate": {"enabled": false, "base_price": 10.00, "per_km_rate": 2.00},
        "express": {"enabled": false, "base_price": 5.00, "per_km_rate": 1.50},
        "cargo": {"enabled": false, "custom_price": null},
        "shipping": {"enabled": false, "custom_price": null},
        "food": {"enabled": false, "base_price": 2.00, "per_km_rate": 0.50},
        "grocery": {"enabled": false, "base_price": 3.00, "per_km_rate": 0.75}
    }'::jsonb,
    
    -- Delivery Promise (bragging rights)
    promised_delivery_time INTEGER CHECK (promised_delivery_time >= 5 AND promised_delivery_time <= 120), -- minutes after pickup
    delivery_promise_message TEXT CHECK (LENGTH(delivery_promise_message) <= 100), -- e.g., "Lightning fast delivery in 15 mins!"
    
    -- Availability & Status
    is_online BOOLEAN DEFAULT false,
    is_available BOOLEAN DEFAULT true,
    max_delivery_distance INTEGER DEFAULT 10 CHECK (max_delivery_distance > 0), -- in km
    operating_hours JSONB DEFAULT '{
        "monday": {"start": "08:00", "end": "20:00"},
        "tuesday": {"start": "08:00", "end": "20:00"},
        "wednesday": {"start": "08:00", "end": "20:00"},
        "thursday": {"start": "08:00", "end": "20:00"},
        "friday": {"start": "08:00", "end": "20:00"},
        "saturday": {"start": "09:00", "end": "18:00"},
        "sunday": {"start": "09:00", "end": "18:00"}
    }'::jsonb,
    
    -- Profile Status
    profile_status VARCHAR(20) DEFAULT 'active' CHECK (profile_status IN ('active', 'inactive', 'suspended')),
    profile_completion INTEGER DEFAULT 0 CHECK (profile_completion >= 0 AND profile_completion <= 100), -- 0-100%
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_rider_profiles_user_id ON rider_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_rider_profiles_vehicle_type ON rider_profiles(vehicle_type);
CREATE INDEX IF NOT EXISTS idx_rider_profiles_online ON rider_profiles(is_online, is_available);
CREATE INDEX IF NOT EXISTS idx_rider_profiles_service_pricing ON rider_profiles USING GIN(service_pricing);
CREATE INDEX IF NOT EXISTS idx_rider_profiles_status ON rider_profiles(profile_status);

-- Enable Row Level Security
ALTER TABLE rider_profiles ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Riders can view their own profile
CREATE POLICY rider_profiles_select_own ON rider_profiles
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- Riders can insert their own profile
CREATE POLICY rider_profiles_insert_own ON rider_profiles
    FOR INSERT TO authenticated
    WITH CHECK (user_id = auth.uid());

-- Riders can update their own profile
CREATE POLICY rider_profiles_update_own ON rider_profiles
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- Service role can do everything
CREATE POLICY rider_profiles_service_all ON rider_profiles
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- Public can view active, online riders (for rider selection)
CREATE POLICY rider_profiles_public_view_active ON rider_profiles
    FOR SELECT TO authenticated
    USING (profile_status = 'active' AND is_online = true);

-- Create trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_rider_profiles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rider_profiles_updated_at_trigger
    BEFORE UPDATE ON rider_profiles
    FOR EACH ROW
    EXECUTE FUNCTION update_rider_profiles_updated_at();

-- Add comment to explain service_pricing structure
COMMENT ON COLUMN rider_profiles.service_pricing IS 'JSONB structure: {
    "intracity": {"enabled": boolean, "base_price": number, "per_km_rate": number},
    "intercity": {"enabled": boolean, "base_price": number, "per_km_rate": number},
    "interstate": {"enabled": boolean, "base_price": number, "per_km_rate": number},
    "express": {"enabled": boolean, "base_price": number, "per_km_rate": number},
    "cargo": {"enabled": boolean, "custom_price": number | null},
    "shipping": {"enabled": boolean, "custom_price": number | null},
    "food": {"enabled": boolean, "base_price": number, "per_km_rate": number},
    "grocery": {"enabled": boolean, "base_price": number, "per_km_rate": number}
}';

COMMENT ON COLUMN rider_profiles.operating_hours IS 'JSONB structure: {
    "monday": {"start": "HH:MM", "end": "HH:MM"},
    "tuesday": {"start": "HH:MM", "end": "HH:MM"},
    ...
}';

COMMIT;

