-- ============================================================
-- Migration 226: Schema reconciliation — capture live-only objects
-- ============================================================
-- Several objects exist only in the live Supabase DB and were never
-- captured in a repo migration. Rebuilding the DB from migrations would
-- silently break: search (tsvector triggers), trending, and rider lookup.
--
-- Extracted verbatim from the live database (pg_get_viewdef /
-- pg_get_functiondef / information_schema / pg_indexes / pg_constraint).
--
-- EVERY statement is idempotent — IF NOT EXISTS / CREATE OR REPLACE /
-- CREATE OR REPLACE TRIGGER. Running this on the live DB is a no-op:
-- nothing is dropped, altered, or re-populated.
--
-- Objects deliberately NOT included (already covered by migrations):
--   - seller_stats table + trg_seller_stats_* triggers  → 170
--   - product_events + product_events_counter_trigger    → 171
--   - trg_update_product_save_count + wishlist trigger   → 172
--   - product counter columns (impression/click/cart)    → 169
-- ============================================================

-- ------------------------------------------------------------
-- 1. rider_locations — live rider GPS positions
-- ------------------------------------------------------------
-- Column list inferred from the live table's constraints/indexes and
-- backend code usage (user_id, is_online, is_available, latitude,
-- longitude, last_ping, current_order_id are confirmed; accuracy/
-- heading/speed/created_at/updated_at are conventional extras — verify
-- against the live information_schema.columns output if exact fidelity
-- matters for a rebuild).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'rider_locations'
  ) THEN
    CREATE TABLE public.rider_locations (
      id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id          uuid        NOT NULL UNIQUE REFERENCES public.user_profiles(id) ON DELETE CASCADE,
      latitude         numeric,
      longitude        numeric,
      accuracy         numeric,
      heading          numeric,
      speed            numeric,
      is_online        boolean     NOT NULL DEFAULT false,
      is_available     boolean     NOT NULL DEFAULT true,
      current_order_id uuid        REFERENCES public.orders(id) ON DELETE SET NULL,
      last_ping        timestamptz,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now()
    );

    -- Fresh rebuilds only: enable RLS with no policies = deny-all for
    -- anon/authenticated keys. Backend access uses the service role,
    -- which bypasses RLS, so functionality is unaffected. Live DB is
    -- untouched — this block is skipped when the table already exists.
    ALTER TABLE public.rider_locations ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

-- For a table that already exists but is missing a column (partial drift):
ALTER TABLE public.rider_locations
  ADD COLUMN IF NOT EXISTS latitude         numeric,
  ADD COLUMN IF NOT EXISTS longitude        numeric,
  ADD COLUMN IF NOT EXISTS accuracy         numeric,
  ADD COLUMN IF NOT EXISTS heading          numeric,
  ADD COLUMN IF NOT EXISTS speed            numeric,
  ADD COLUMN IF NOT EXISTS is_online        boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_available     boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS current_order_id uuid,
  ADD COLUMN IF NOT EXISTS last_ping        timestamptz,
  ADD COLUMN IF NOT EXISTS created_at       timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();

-- Indexes (exact live definitions)
CREATE INDEX IF NOT EXISTS idx_rider_locations_user_id
  ON public.rider_locations USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_rider_locations_online
  ON public.rider_locations USING btree (is_online, is_available);
CREATE INDEX IF NOT EXISTS idx_rider_locations_coords
  ON public.rider_locations USING btree (latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_rider_locations_last_ping
  ON public.rider_locations USING btree (last_ping DESC);

-- ------------------------------------------------------------
-- 2. calculate_distance — haversine km (dependency of find_nearby_riders)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.calculate_distance(lat1 numeric, lon1 numeric, lat2 numeric, lon2 numeric)
RETURNS numeric
LANGUAGE plpgsql
AS $function$
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
$function$;

-- ------------------------------------------------------------
-- 3. find_nearby_riders — PostGIS-free nearby-rider lookup
--    (online + fresh ping < 10min + within max_distance km)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.find_nearby_riders(pickup_lat numeric, pickup_lon numeric, max_distance numeric DEFAULT 5.0)
RETURNS TABLE(rider_id uuid, rider_name character varying, distance numeric, is_available boolean, vehicle_type character varying, last_ping timestamp with time zone)
LANGUAGE plpgsql
AS $function$
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
$function$;

-- ------------------------------------------------------------
-- 4. search_vector — full-text search on products + services
--    Column: tsvector, populated by BEFORE INSERT/UPDATE triggers.
-- ------------------------------------------------------------
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS search_vector tsvector;
ALTER TABLE public.services ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE OR REPLACE FUNCTION public.update_products_search_vector()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(array_to_string(NEW.tags, ' '), '')), 'C') ||
        setweight(to_tsvector('english', coalesce(NEW.location, '')), 'D');
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_services_search_vector()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.search_vector :=
        setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(array_to_string(NEW.tags, ' '), '')), 'C') ||
        setweight(to_tsvector('english', coalesce(NEW.location, '')), 'D');
    RETURN NEW;
END;
$function$;

-- Live wiring: BEFORE INSERT OR UPDATE on each table.
-- Guarded: only created when absent — a CREATE OR REPLACE TRIGGER could
-- silently drop a WHEN/UPDATE-OF clause on the live trigger that the
-- extraction didn't capture, so we never touch an existing trigger.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'products_search_vector_trigger'
      AND tgrelid = 'public.products'::regclass
  ) THEN
    CREATE TRIGGER products_search_vector_trigger
      BEFORE INSERT OR UPDATE ON public.products
      FOR EACH ROW EXECUTE FUNCTION public.update_products_search_vector();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'services_search_vector_trigger'
      AND tgrelid = 'public.services'::regclass
  ) THEN
    CREATE TRIGGER services_search_vector_trigger
      BEFORE INSERT OR UPDATE ON public.services
      FOR EACH ROW EXECUTE FUNCTION public.update_services_search_vector();
  END IF;
END $$;

-- GIN indexes so @@ tsquery searches are indexed (safe to add even if
-- the live DB lacks them — pure performance improvement).
CREATE INDEX IF NOT EXISTS idx_products_search_vector
  ON public.products USING gin (search_vector);
CREATE INDEX IF NOT EXISTS idx_services_search_vector
  ON public.services USING gin (search_vector);

-- ------------------------------------------------------------
-- 5. trending_products — sales-recency-weighted product view
--    (exact live definition; weights decay 20/10/3/1 over 1d/7d/30d/90d)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.trending_products AS
 SELECT oi.product_id,
    count(DISTINCT o.id) AS order_count,
    sum(oi.quantity) AS total_quantity,
    sum(
        CASE
            WHEN o.created_at >= (now() - '1 day'::interval) THEN oi.quantity * 20
            WHEN o.created_at >= (now() - '7 days'::interval) THEN oi.quantity * 10
            WHEN o.created_at >= (now() - '30 days'::interval) THEN oi.quantity * 3
            WHEN o.created_at >= (now() - '90 days'::interval) THEN oi.quantity * 1
            ELSE 0
        END) AS trending_score
   FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
  WHERE oi.product_id IS NOT NULL AND (o.status::text = ANY (ARRAY['paid'::character varying, 'assigned'::character varying, 'in_transit'::character varying, 'delivered'::character varying, 'completed'::character varying]::text[])) AND o.created_at >= (now() - '90 days'::interval)
  GROUP BY oi.product_id;

-- ------------------------------------------------------------
-- Verify
-- ------------------------------------------------------------
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
    WHERE table_schema='public' AND table_name='rider_locations')
    THEN missing := missing || 'rider_locations table'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='calculate_distance')
    THEN missing := missing || 'calculate_distance()'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='find_nearby_riders')
    THEN missing := missing || 'find_nearby_riders()'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='products' AND column_name='search_vector')
    THEN missing := missing || 'products.search_vector'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='services' AND column_name='search_vector')
    THEN missing := missing || 'services.search_vector'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.views
    WHERE table_schema='public' AND table_name='trending_products')
    THEN missing := missing || 'trending_products view'; END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE WARNING 'Schema reconciliation incomplete — missing: %', missing;
  ELSE
    RAISE NOTICE 'Schema reconciliation complete — all objects present';
  END IF;
END $$;
