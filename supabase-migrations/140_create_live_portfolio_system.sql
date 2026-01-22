-- =====================================================
-- CREATE LIVE PORTFOLIO SYSTEM
-- Migration: 140
-- Date: 2025-01-XX
-- Description: Portfolio services with multi-image support, analytics, and cleanup
-- Allows service providers to showcase work samples during live streams
-- =====================================================

BEGIN;

-- =====================================================
-- LIVE PORTFOLIO SERVICES TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS live_portfolio_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NOT NULL CHECK (price >= 0),
  category VARCHAR(50) NOT NULL CHECK (category IN ('work_sample', 'consultation', 'service_package', 'testimonial')),
  
  -- Analytics fields
  impressions INTEGER DEFAULT 0 CHECK (impressions >= 0),
  add_to_cart_clicks INTEGER DEFAULT 0 CHECK (add_to_cart_clicks >= 0),
  bookings INTEGER DEFAULT 0 CHECK (bookings >= 0),
  revenue DECIMAL(10,2) DEFAULT 0 CHECK (revenue >= 0),
  
  -- Cleanup tracking
  deleted_at TIMESTAMP WITH TIME ZONE,
  is_active BOOLEAN DEFAULT TRUE,
  
  -- Metadata
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- LIVE PORTFOLIO IMAGES TABLE
-- Supports multi-image portfolios (before/after galleries)
-- =====================================================

CREATE TABLE IF NOT EXISTS live_portfolio_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id UUID NOT NULL REFERENCES live_portfolio_services(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  caption VARCHAR(255),
  display_order INTEGER DEFAULT 0,
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- LIVE TIME SLOTS TABLE
-- Allows hosts to define available booking times for services
-- =====================================================

CREATE TABLE IF NOT EXISTS live_time_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id UUID NOT NULL REFERENCES live_streams(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  is_available BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

-- Portfolio services indexes
CREATE INDEX IF NOT EXISTS idx_portfolio_services_stream_id ON live_portfolio_services(stream_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_services_category ON live_portfolio_services(category);
CREATE INDEX IF NOT EXISTS idx_portfolio_services_active ON live_portfolio_services(stream_id, is_active) WHERE is_active = TRUE AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_portfolio_services_deleted_at ON live_portfolio_services(deleted_at) WHERE deleted_at IS NOT NULL;

-- Portfolio images indexes
CREATE INDEX IF NOT EXISTS idx_portfolio_images_portfolio_id ON live_portfolio_images(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_images_display_order ON live_portfolio_images(portfolio_id, display_order);
CREATE INDEX IF NOT EXISTS idx_portfolio_images_primary ON live_portfolio_images(portfolio_id, is_primary) WHERE is_primary = TRUE;

-- Time slots indexes
CREATE INDEX IF NOT EXISTS idx_time_slots_stream_id ON live_time_slots(stream_id);
CREATE INDEX IF NOT EXISTS idx_time_slots_date ON live_time_slots(stream_id, date, is_available) WHERE is_available = TRUE;
CREATE INDEX IF NOT EXISTS idx_time_slots_date_range ON live_time_slots(date, start_time, end_time) WHERE is_available = TRUE;

-- =====================================================
-- UNIQUE CONSTRAINTS
-- =====================================================

-- Ensure only one primary image per portfolio
CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_images_single_primary 
ON live_portfolio_images(portfolio_id) 
WHERE is_primary = TRUE;

-- =====================================================
-- FUNCTION: UPDATE PORTFOLIO UPDATED_AT
-- =====================================================

CREATE OR REPLACE FUNCTION update_portfolio_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for portfolio services updated_at
CREATE TRIGGER set_portfolio_updated_at
  BEFORE UPDATE ON live_portfolio_services
  FOR EACH ROW
  EXECUTE FUNCTION update_portfolio_updated_at();

-- Trigger for time slots updated_at
CREATE TRIGGER set_time_slots_updated_at
  BEFORE UPDATE ON live_time_slots
  FOR EACH ROW
  EXECUTE FUNCTION update_portfolio_updated_at();

-- =====================================================
-- FUNCTION: CLEANUP ORPHANED PORTFOLIO ITEMS
-- Soft deletes portfolio items that haven't generated value after grace period
-- =====================================================

CREATE OR REPLACE FUNCTION cleanup_orphaned_portfolio_items()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cleaned_count INTEGER := 0;
  v_grace_period_days INTEGER := 30;
  v_cutoff_date TIMESTAMP WITH TIME ZONE;
  v_portfolio RECORD;
BEGIN
  v_cutoff_date := NOW() - (v_grace_period_days || ' days')::INTERVAL;
  
  -- Find portfolio items that should be soft-deleted
  FOR v_portfolio IN
    SELECT 
      p.id,
      p.stream_id,
      p.created_at
    FROM live_portfolio_services p
    INNER JOIN live_streams s ON p.stream_id = s.id
    WHERE p.deleted_at IS NULL
      AND p.is_active = TRUE
      AND p.created_at < v_cutoff_date
      AND s.status = 'ended'  -- Only clean up items from ended streams
      AND p.bookings = 0  -- No bookings
      AND p.revenue = 0  -- No revenue
      AND p.impressions < 10  -- Low engagement
      -- Not linked to active orders (check via order_items if portfolio references exist)
    FOR UPDATE  -- Lock rows to prevent concurrent modifications
  LOOP
    -- Soft delete: mark as inactive and set deleted_at
    UPDATE live_portfolio_services
    SET 
      is_active = FALSE,
      deleted_at = NOW(),
      updated_at = NOW()
    WHERE id = v_portfolio.id;
    
    v_cleaned_count := v_cleaned_count + 1;
  END LOOP;
  
  -- Hard delete portfolio items that have been soft-deleted for more than 30 days
  -- This permanently removes truly orphaned data
  DELETE FROM live_portfolio_images
  WHERE portfolio_id IN (
    SELECT id FROM live_portfolio_services
    WHERE deleted_at IS NOT NULL
      AND deleted_at < (NOW() - (v_grace_period_days || ' days')::INTERVAL)
  );
  
  DELETE FROM live_portfolio_services
  WHERE deleted_at IS NOT NULL
    AND deleted_at < (NOW() - (v_grace_period_days || ' days')::INTERVAL);
  
  RETURN v_cleaned_count;
END;
$$;

COMMENT ON FUNCTION cleanup_orphaned_portfolio_items() IS 
'Cleans up portfolio items from ended streams that have no bookings, revenue, or engagement. Soft deletes first, then hard deletes after grace period. Should be called daily via cron job.';

-- =====================================================
-- FUNCTION: GET PORTFOLIO ANALYTICS
-- Aggregates analytics for portfolio items in a stream
-- =====================================================

CREATE OR REPLACE FUNCTION get_portfolio_analytics(p_stream_id UUID)
RETURNS TABLE (
  portfolio_id UUID,
  title VARCHAR,
  impressions INTEGER,
  add_to_cart_clicks INTEGER,
  bookings INTEGER,
  revenue DECIMAL,
  conversion_rate DECIMAL,
  avg_booking_value DECIMAL
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    p.id as portfolio_id,
    p.title,
    p.impressions,
    p.add_to_cart_clicks,
    p.bookings,
    p.revenue,
    CASE 
      WHEN p.impressions > 0 THEN (p.bookings::DECIMAL / p.impressions::DECIMAL)
      ELSE 0::DECIMAL
    END as conversion_rate,
    CASE
      WHEN p.bookings > 0 THEN (p.revenue / p.bookings::DECIMAL)
      ELSE 0::DECIMAL
    END as avg_booking_value
  FROM live_portfolio_services p
  WHERE p.stream_id = p_stream_id
    AND p.deleted_at IS NULL
    AND p.is_active = TRUE
  ORDER BY p.revenue DESC, p.impressions DESC;
END;
$$;

COMMENT ON FUNCTION get_portfolio_analytics(UUID) IS 
'Returns analytics summary for all portfolio items in a stream, including conversion rates and average booking values.';

-- =====================================================
-- FUNCTION: TRACK PORTFOLIO IMPRESSION
-- Increments impression count when portfolio item is showcased
-- =====================================================

CREATE OR REPLACE FUNCTION track_portfolio_impression(p_portfolio_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE live_portfolio_services
  SET 
    impressions = impressions + 1,
    updated_at = NOW()
  WHERE id = p_portfolio_id
    AND deleted_at IS NULL
    AND is_active = TRUE;
END;
$$;

COMMENT ON FUNCTION track_portfolio_impression(UUID) IS 
'Increments impression count for a portfolio item when it is showcased to viewers.';

-- =====================================================
-- FUNCTION: TRACK PORTFOLIO ADD TO CART
-- Increments add-to-cart click count
-- =====================================================

CREATE OR REPLACE FUNCTION track_portfolio_add_to_cart(p_portfolio_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE live_portfolio_services
  SET 
    add_to_cart_clicks = add_to_cart_clicks + 1,
    updated_at = NOW()
  WHERE id = p_portfolio_id
    AND deleted_at IS NULL
    AND is_active = TRUE;
END;
$$;

COMMENT ON FUNCTION track_portfolio_add_to_cart(UUID) IS 
'Increments add-to-cart click count when a viewer adds a portfolio item to their cart.';

-- =====================================================
-- FUNCTION: UPDATE PORTFOLIO BOOKING STATS
-- Updates bookings and revenue when portfolio service is booked
-- =====================================================

CREATE OR REPLACE FUNCTION update_portfolio_booking_stats(
  p_portfolio_id UUID,
  p_booking_amount DECIMAL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE live_portfolio_services
  SET 
    bookings = bookings + 1,
    revenue = revenue + COALESCE(p_booking_amount, 0),
    updated_at = NOW()
  WHERE id = p_portfolio_id
    AND deleted_at IS NULL
    AND is_active = TRUE;
END;
$$;

COMMENT ON FUNCTION update_portfolio_booking_stats(UUID, DECIMAL) IS 
'Updates booking count and revenue when a portfolio service is successfully booked.';

-- =====================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- =====================================================

-- Enable RLS on all tables
ALTER TABLE live_portfolio_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_portfolio_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_time_slots ENABLE ROW LEVEL SECURITY;

-- Portfolio Services: Anyone can read active portfolio items
CREATE POLICY "Anyone can view active portfolio services"
  ON live_portfolio_services FOR SELECT
  USING (is_active = TRUE AND deleted_at IS NULL);

-- Portfolio Services: Vendors can manage their own portfolio items
CREATE POLICY "Vendors can manage own portfolio services"
  ON live_portfolio_services FOR ALL
  USING (
    stream_id IN (
      SELECT id FROM live_streams 
      WHERE vendor_id = auth.uid()
    )
  );

-- Portfolio Images: Anyone can read images for active portfolios
CREATE POLICY "Anyone can view portfolio images"
  ON live_portfolio_images FOR SELECT
  USING (
    portfolio_id IN (
      SELECT id FROM live_portfolio_services
      WHERE is_active = TRUE AND deleted_at IS NULL
    )
  );

-- Portfolio Images: Vendors can manage images for their portfolios
CREATE POLICY "Vendors can manage portfolio images"
  ON live_portfolio_images FOR ALL
  USING (
    portfolio_id IN (
      SELECT p.id FROM live_portfolio_services p
      INNER JOIN live_streams s ON p.stream_id = s.id
      WHERE s.vendor_id = auth.uid()
    )
  );

-- Time Slots: Anyone can view available time slots
CREATE POLICY "Anyone can view available time slots"
  ON live_time_slots FOR SELECT
  USING (is_available = TRUE);

-- Time Slots: Vendors can manage time slots for their streams
CREATE POLICY "Vendors can manage time slots"
  ON live_time_slots FOR ALL
  USING (
    stream_id IN (
      SELECT id FROM live_streams 
      WHERE vendor_id = auth.uid()
    )
  );

-- Service role bypass (for backend operations)
CREATE POLICY "Service role can manage all portfolio data"
  ON live_portfolio_services FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role can manage all portfolio images"
  ON live_portfolio_images FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role can manage all time slots"
  ON live_time_slots FOR ALL
  USING (auth.role() = 'service_role');

COMMIT;

-- =====================================================
-- VERIFICATION QUERIES
-- =====================================================

-- Check table structures
SELECT 
  'live_portfolio_services' as table_name,
  column_name, 
  data_type, 
  is_nullable, 
  column_default
FROM information_schema.columns
WHERE table_name = 'live_portfolio_services'
ORDER BY ordinal_position;

SELECT 
  'live_portfolio_images' as table_name,
  column_name, 
  data_type, 
  is_nullable, 
  column_default
FROM information_schema.columns
WHERE table_name = 'live_portfolio_images'
ORDER BY ordinal_position;

SELECT 
  'live_time_slots' as table_name,
  column_name, 
  data_type, 
  is_nullable, 
  column_default
FROM information_schema.columns
WHERE table_name = 'live_time_slots'
ORDER BY ordinal_position;

-- Check indexes
SELECT 
  tablename, 
  indexname, 
  indexdef
FROM pg_indexes
WHERE tablename IN ('live_portfolio_services', 'live_portfolio_images', 'live_time_slots')
ORDER BY tablename, indexname;

-- Check RLS policies
SELECT 
  tablename, 
  policyname, 
  permissive, 
  roles, 
  cmd
FROM pg_policies
WHERE tablename IN ('live_portfolio_services', 'live_portfolio_images', 'live_time_slots')
ORDER BY tablename, policyname;

-- Check functions
SELECT 
  routine_name,
  routine_type,
  data_type as return_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'cleanup_orphaned_portfolio_items',
    'get_portfolio_analytics',
    'track_portfolio_impression',
    'track_portfolio_add_to_cart',
    'update_portfolio_booking_stats'
  )
ORDER BY routine_name;

-- Table comments
COMMENT ON TABLE live_portfolio_services IS 'Portfolio services that can be showcased during live streams (v140)';
COMMENT ON TABLE live_portfolio_images IS 'Multiple images per portfolio item for before/after galleries (v140)';
COMMENT ON TABLE live_time_slots IS 'Available booking time slots for service streams (v140)';

