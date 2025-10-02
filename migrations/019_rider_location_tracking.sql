-- Migration: Rider location tracking system
-- Date: 2025-01-15
-- Description: Add rider location tracking and status for real-time delivery

-- Create rider_locations table for real-time location tracking
CREATE TABLE IF NOT EXISTS rider_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Location data
    latitude DECIMAL(10,8) NOT NULL,
    longitude DECIMAL(11,8) NOT NULL,
    accuracy DECIMAL(6,2), -- GPS accuracy in meters
    
    -- Status
    is_online BOOLEAN DEFAULT FALSE,
    is_available BOOLEAN DEFAULT FALSE,
    current_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
    
    -- Metadata
    last_ping TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    battery_level INTEGER, -- 0-100
    app_version VARCHAR(20),
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    UNIQUE(user_id)
);

-- Add indexes for location queries
CREATE INDEX IF NOT EXISTS idx_rider_locations_user_id ON rider_locations(user_id);
CREATE INDEX IF NOT EXISTS idx_rider_locations_online ON rider_locations(is_online, is_available);
CREATE INDEX IF NOT EXISTS idx_rider_locations_coords ON rider_locations(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_rider_locations_last_ping ON rider_locations(last_ping DESC);

-- Create function to calculate distance between two points (Haversine formula)
CREATE OR REPLACE FUNCTION calculate_distance(
    lat1 DECIMAL, lon1 DECIMAL, 
    lat2 DECIMAL, lon2 DECIMAL
) RETURNS DECIMAL AS $$
DECLARE
    r DECIMAL := 6371; -- Earth radius in kilometers
    dlat DECIMAL;
    dlon DECIMAL;
    a DECIMAL;
    c DECIMAL;
BEGIN
    dlat := RADIANS(lat2 - lat1);
    dlon := RADIANS(lon2 - lon1);
    a := SIN(dlat/2) * SIN(dlat/2) + COS(RADIANS(lat1)) * COS(RADIANS(lat2)) * SIN(dlon/2) * SIN(dlon/2);
    c := 2 * ASIN(SQRT(a));
    RETURN r * c;
END;
$$ LANGUAGE plpgsql;

-- Function to find nearby riders
CREATE OR REPLACE FUNCTION find_nearby_riders(
    pickup_lat DECIMAL,
    pickup_lon DECIMAL,
    max_distance DECIMAL DEFAULT 5.0
) RETURNS TABLE (
    rider_id UUID,
    rider_name VARCHAR,
    distance DECIMAL,
    is_available BOOLEAN,
    vehicle_type VARCHAR,
    last_ping TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        up.id,
        up.username,
        calculate_distance(pickup_lat, pickup_lon, rl.latitude, rl.longitude) as dist,
        rl.is_available,
        COALESCE(up.preferences->>'vehicleType', 'bike')::VARCHAR,
        rl.last_ping
    FROM user_profiles up
    JOIN rider_locations rl ON up.id = rl.user_id
    WHERE 
        up.is_rider = true
        AND rl.is_online = true
        AND rl.last_ping > NOW() - INTERVAL '10 minutes'
        AND calculate_distance(pickup_lat, pickup_lon, rl.latitude, rl.longitude) <= max_distance
    ORDER BY dist ASC;
END;
$$ LANGUAGE plpgsql;

-- Update trigger for rider_locations
DROP TRIGGER IF EXISTS update_rider_locations_updated_at ON rider_locations;
CREATE TRIGGER update_rider_locations_updated_at 
    BEFORE UPDATE ON rider_locations 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Create API function to update rider location
CREATE OR REPLACE FUNCTION update_rider_location(
    rider_id UUID,
    new_lat DECIMAL,
    new_lon DECIMAL,
    new_accuracy DECIMAL DEFAULT NULL,
    online_status BOOLEAN DEFAULT TRUE,
    available_status BOOLEAN DEFAULT TRUE
) RETURNS BOOLEAN AS $$
BEGIN
    INSERT INTO rider_locations (
        user_id, latitude, longitude, accuracy, 
        is_online, is_available, last_ping
    ) VALUES (
        rider_id, new_lat, new_lon, new_accuracy,
        online_status, available_status, NOW()
    )
    ON CONFLICT (user_id) DO UPDATE SET
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        accuracy = EXCLUDED.accuracy,
        is_online = EXCLUDED.is_online,
        is_available = EXCLUDED.is_available,
        last_ping = NOW(),
        updated_at = NOW();
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON rider_locations TO authenticated;
GRANT EXECUTE ON FUNCTION calculate_distance TO authenticated;
GRANT EXECUTE ON FUNCTION find_nearby_riders TO authenticated;
GRANT EXECUTE ON FUNCTION update_rider_location TO authenticated;

-- Service role needs full access
GRANT ALL ON rider_locations TO service_role;

COMMIT;