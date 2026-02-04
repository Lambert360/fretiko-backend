-- Migration: Add pricing mode toggle to rider profiles
-- Date: 2025-01-30
-- Description: Add pricing_mode field to rider_profiles for formula vs range pricing

-- Add pricing mode field to rider_profiles
ALTER TABLE rider_profiles ADD COLUMN IF NOT EXISTS pricing_mode VARCHAR(20) DEFAULT 'formula' CHECK (pricing_mode IN (
    'formula', 'range', 'hybrid'
));

-- Add pricing range fields for range mode
ALTER TABLE rider_profiles ADD COLUMN IF NOT EXISTS pricing_range JSONB DEFAULT NULL;

-- Add pricing preferences for hybrid mode
ALTER TABLE rider_profiles ADD COLUMN IF NOT EXISTS pricing_preferences JSONB DEFAULT NULL;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_rider_profiles_pricing_mode ON rider_profiles(pricing_mode);

-- Add comments for documentation
COMMENT ON COLUMN rider_profiles.pricing_mode IS 'Pricing mode: formula (base_price + per_km_rate), range (min_price + max_price), or hybrid (combination)';
COMMENT ON COLUMN rider_profiles.pricing_range IS 'Price range for range mode: {min_price, max_price, preferred_price}';
COMMENT ON COLUMN rider_profiles.pricing_preferences IS 'Hybrid pricing preferences: {use_formula_for_short_distance, use_range_for_long_distance, threshold_km}';

-- Update existing profiles to have proper pricing_range if they have service_pricing
UPDATE rider_profiles 
SET pricing_range = jsonb_build_object(
    'min_price', COALESCE((service_pricing->'intracity'->>'base_price')::numeric, 2.0),
    'max_price', COALESCE((service_pricing->'intracity'->>'base_price')::numeric, 2.0) + 20.0,
    'preferred_price', COALESCE((service_pricing->'intracity'->>'base_price')::numeric, 2.0) + 10.0
)
WHERE pricing_range IS NULL 
  AND service_pricing IS NOT NULL
  AND pricing_mode = 'formula';

-- Update existing profiles to have pricing_preferences for hybrid mode
UPDATE rider_profiles 
SET pricing_preferences = jsonb_build_object(
    'use_formula_for_short_distance', true,
    'use_range_for_long_distance', true,
    'threshold_km', 10,
    'formula_max_distance', 5,
    'range_min_distance', 5
)
WHERE pricing_preferences IS NULL 
  AND pricing_mode = 'formula';

-- Create function to calculate rider price based on pricing mode
CREATE OR REPLACE FUNCTION calculate_rider_price(
    rider_profile_id UUID,
    distance_km NUMERIC,
    service_category VARCHAR DEFAULT 'intracity',
    order_amount NUMERIC DEFAULT NULL
) RETURNS NUMERIC AS $$
DECLARE
    profile RECORD;
    calculated_price NUMERIC;
BEGIN
    -- Get rider profile
    SELECT * INTO profile 
    FROM rider_profiles 
    WHERE id = rider_profile_id;
    
    IF NOT FOUND THEN
        RETURN 7.5; -- Default price
    END IF;
    
    -- Calculate price based on pricing mode
    CASE profile.pricing_mode
        WHEN 'formula' THEN
            -- Formula mode: base_price + (distance * per_km_rate)
            IF profile.service_pricing ? 
                profile.service_pricing->service_category THEN
                calculated_price := COALESCE(
                    (profile.service_pricing->service_category->>'base_price')::numeric, 2.0
                ) + (
                    distance_km * COALESCE(
                        (profile.service_pricing->service_category->>'per_km_rate')::numeric, 0.5
                    )
                );
            ELSE
                calculated_price := 7.5; -- Default formula price
            END IF;
            
        WHEN 'range' THEN
            -- Range mode: use preferred_price within range
            IF profile.pricing_range ? 
                profile.pricing_range->>'preferred_price' THEN
                calculated_price := (profile.pricing_range->>'preferred_price')::numeric;
            ELSE
                calculated_price := 7.5; -- Default price
            END IF;
            
        WHEN 'hybrid' THEN
            -- Hybrid mode: use formula for short distances, range for long distances
            IF profile.pricing_preferences ? 
                profile.pricing_preferences->>'use_formula_for_short_distance' AND
                distance_km <= COALESCE((profile.pricing_preferences->>'threshold_km')::numeric, 10.0) THEN
                
                -- Use formula pricing
                IF profile.service_pricing ? 
                    profile.service_pricing->service_category THEN
                    calculated_price := COALESCE(
                        (profile.service_pricing->service_category->>'base_price')::numeric, 2.0
                    ) + (
                        distance_km * COALESCE(
                            (profile.service_pricing->service_category->>'per_km_rate')::numeric, 0.5
                        )
                    );
                ELSE
                    calculated_price := 7.5;
                END IF;
                
            ELSIF profile.pricing_preferences ? 
                profile.pricing_preferences->>'use_range_for_long_distance' AND
                distance_km > COALESCE((profile.pricing_preferences->>'threshold_km')::numeric, 10.0) THEN
                
                -- Use range pricing
                IF profile.pricing_range ? 
                    profile.pricing_range->>'preferred_price' THEN
                    calculated_price := (profile.pricing_range->>'preferred_price')::numeric;
                ELSE
                    calculated_price := 7.5;
                END IF;
                
            ELSE
                -- Default to formula
                IF profile.service_pricing ? 
                    profile.service_pricing->service_category THEN
                    calculated_price := COALESCE(
                        (profile.service_pricing->service_category->>'base_price')::numeric, 2.0
                    ) + (
                        distance_km * COALESCE(
                            (profile.service_pricing->service_category->>'per_km_rate')::numeric, 0.5
                        )
                    );
                ELSE
                    calculated_price := 7.5;
                END IF;
            END IF;
            
        ELSE
            -- Default to formula mode
            IF profile.service_pricing ? 
                profile.service_pricing->service_category THEN
                calculated_price := COALESCE(
                    (profile.service_pricing->service_category->>'base_price')::numeric, 2.0
                ) + (
                    distance_km * COALESCE(
                        (profile.service_pricing->service_category->>'per_km_rate')::numeric, 0.5
                    )
                );
            ELSE
                calculated_price := 7.5;
            END IF;
    END CASE;
    
    -- Apply minimum and maximum constraints
    calculated_price := GREATEST(calculated_price, 1.0); -- Minimum price
    calculated_price := LEAST(calculated_price, 100.0); -- Maximum price
    
    RETURN calculated_price;
END;
$$ LANGUAGE plpgsql;

-- Create function to check if order price is compatible with rider pricing
CREATE OR REPLACE FUNCTION check_price_compatibility(
    rider_profile_id UUID,
    order_price NUMERIC,
    service_category VARCHAR DEFAULT 'intracity'
) RETURNS JSONB AS $$
DECLARE
    profile RECORD;
    compatibility JSONB;
    price_diff NUMERIC;
    price_diff_percent NUMERIC;
BEGIN
    -- Get rider profile
    SELECT * INTO profile 
    FROM rider_profiles 
    WHERE id = rider_profile_id;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'compatible', true,
            'compatibility_type', 'unknown',
            'message', 'Rider profile not found'
        );
    END IF;
    
    -- Check compatibility based on pricing mode
    CASE profile.pricing_mode
        WHEN 'formula' THEN
            -- Formula mode: always compatible
            compatibility := jsonb_build_object(
                'compatible', true,
                'compatibility_type', 'perfect',
                'message', 'Formula pricing - always compatible',
                'rider_pricing_mode', 'formula'
            );
            
        WHEN 'range' THEN
            -- Range mode: check if order price is within rider's range
            IF profile.pricing_range ? 
                profile.pricing_range->>'min_price' AND
                profile.pricing_range ? 
                profile.pricing_range->>'max_price' THEN
                
                price_diff := order_price - (profile.pricing_range->>'preferred_price')::numeric;
                price_diff_percent := (price_diff / (profile.pricing_range->>'preferred_price')::numeric) * 100;
                
                IF order_price >= (profile.pricing_range->>'min_price')::numeric AND 
                   order_price <= (profile.pricing_range->>'max_price')::numeric THEN
                    
                    compatibility := jsonb_build_object(
                        'compatible', true,
                        'compatibility_type', 'perfect',
                        'message', 'Price within rider range',
                        'rider_pricing_mode', 'range',
                        'price_diff', price_diff,
                        'price_diff_percent', price_diff_percent
                    );
                    
                ELSIF order_price < (profile.pricing_range->>'min_price')::numeric THEN
                    
                    compatibility := jsonb_build_object(
                        'compatible', true,
                        'compatibility_type', 'below_range',
                        'message', 'Price below rider minimum range',
                        'rider_pricing_mode', 'range',
                        'price_diff', price_diff,
                        'price_diff_percent', price_diff_percent,
                        'rider_min_price', (profile.pricing_range->>'min_price')::numeric,
                        'rider_max_price', (profile.pricing_range->>'max_price')::numeric
                    );
                    
                ELSE
                    
                    compatibility := jsonb_build_object(
                        'compatible', true,
                        'compatibility_type', 'above_range',
                        'message', 'Price above rider maximum range',
                        'rider_pricing_mode', 'range',
                        'price_diff', price_diff,
                        'price_diff_percent', price_diff_percent,
                        'rider_min_price', (profile.pricing_range->>'min_price')::numeric,
                        'rider_max_price', (profile.pricing_range->>'max_price')::numeric
                    );
                    
                END IF;
                
            ELSE
                compatibility := jsonb_build_object(
                    'compatible', true,
                    'compatibility_type', 'unknown',
                    'message', 'Range pricing - no range set',
                    'rider_pricing_mode', 'range'
                );
            END IF;
            
        WHEN 'hybrid' THEN
            -- Hybrid mode: check based on distance and preferences
            IF profile.pricing_preferences ? 
                profile.pricing_preferences->>'use_formula_for_short_distance' AND
                service_category = 'intracity' THEN
                
                compatibility := jsonb_build_object(
                    'compatible', true,
                    'compatibility_type', 'perfect',
                    'message', 'Hybrid pricing - formula mode active',
                    'rider_pricing_mode', 'hybrid',
                    'active_mode', 'formula'
                );
                
            ELSIF profile.pricing_preferences ? 
                profile.pricing_preferences->>'use_range_for_long_distance' THEN
                
                compatibility := jsonb_build_object(
                    'compatible', true,
                    'compatibility_type', 'perfect',
                    'message', 'Hybrid pricing - range mode active',
                    'rider_pricing_mode', 'hybrid',
                    'active_mode', 'range'
                );
                
            ELSE
                compatibility := jsonb_build_object(
                    'compatible', true,
                    'compatibility_type', 'perfect',
                    'message', 'Hybrid pricing - default formula mode',
                    'rider_pricing_mode', 'hybrid',
                    'active_mode', 'formula'
                );
            END IF;
            
        ELSE
            -- Default to formula mode
            compatibility := jsonb_build_object(
                'compatible', true,
                'compatibility_type', 'perfect',
                'message', 'Default formula pricing',
                'rider_pricing_mode', 'formula'
            );
    END CASE;
    
    RETURN compatibility;
END;
$$ LANGUAGE plpgsql;

COMMIT;
