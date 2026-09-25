-- ============================================================
-- Migration 224: Item location coordinates
-- ============================================================
-- products.location / services.location are free-text ("State, Country")
-- set at upload time. Delivery pricing needs real coordinates:
--   pickup coords  -> products/services location_lat/lng (item location)
--   route distance -> haversine(pickup, delivery) for per_km pricing
--
-- Columns are nullable: pre-existing rows and clients that don't send
-- coords keep working — distance logic falls back when coords are absent.
--
-- These are ITEM locations (where the product/service is), distinct from
-- user_profiles.location (the vendor's own location). Do not conflate.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS location_latitude  NUMERIC(9,6)
    CHECK (location_latitude  IS NULL OR location_latitude  BETWEEN -90  AND 90),
  ADD COLUMN IF NOT EXISTS location_longitude NUMERIC(9,6)
    CHECK (location_longitude IS NULL OR location_longitude BETWEEN -180 AND 180);

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS location_latitude  NUMERIC(9,6)
    CHECK (location_latitude  IS NULL OR location_latitude  BETWEEN -90  AND 90),
  ADD COLUMN IF NOT EXISTS location_longitude NUMERIC(9,6)
    CHECK (location_longitude IS NULL OR location_longitude BETWEEN -180 AND 180);

-- Cheap lookup for "items with known pickup coords"
CREATE INDEX IF NOT EXISTS idx_products_location_coords
  ON public.products(location_latitude, location_longitude)
  WHERE location_latitude IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_services_location_coords
  ON public.services(location_latitude, location_longitude)
  WHERE location_latitude IS NOT NULL;
