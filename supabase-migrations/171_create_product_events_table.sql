-- Migration 171: Create product_events table for impression/click/cart_add tracking
-- Powers "seen" penalty and engagement counters for product ranking.

CREATE TABLE IF NOT EXISTS public.product_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  event_type VARCHAR(20) NOT NULL CHECK (event_type IN (
    'impression', 'click', 'view', 'cart_add', 'wishlist_add'
  )),
  source VARCHAR(30), -- e.g. 'home_feed', 'search', 'category', 'wishlist'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.product_events IS 'Per-user product engagement events (impressions, clicks, cart adds) for ranking and seen-penalty logic.';

CREATE INDEX IF NOT EXISTS idx_product_events_user_id ON public.product_events(user_id);
CREATE INDEX IF NOT EXISTS idx_product_events_product_id ON public.product_events(product_id);
CREATE INDEX IF NOT EXISTS idx_product_events_event_type ON public.product_events(event_type);
CREATE INDEX IF NOT EXISTS idx_product_events_created_at ON public.product_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_events_user_product ON public.product_events(user_id, product_id, created_at DESC);

ALTER TABLE public.product_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert their own product events"
ON public.product_events FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

CREATE POLICY "Users can view their own product events"
ON public.product_events FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "Service role can manage all product events"
ON public.product_events FOR ALL
TO service_role
USING (true);

-- ================================
-- COUNTER TRIGGERS
-- ================================

CREATE OR REPLACE FUNCTION public.trg_update_product_counters()
RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF NEW.event_type = 'impression' THEN
      UPDATE public.products SET impression_count = impression_count + 1 WHERE id = NEW.product_id;
    ELSIF NEW.event_type = 'click' THEN
      UPDATE public.products SET click_count = click_count + 1 WHERE id = NEW.product_id;
    ELSIF NEW.event_type = 'cart_add' THEN
      UPDATE public.products SET cart_add_count = cart_add_count + 1 WHERE id = NEW.product_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Never let a counter-update failure roll back the event insert itself
    RAISE WARNING 'product counter update failed for product %: %', NEW.product_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_events_counter_trigger ON public.product_events;
CREATE TRIGGER product_events_counter_trigger
  AFTER INSERT ON public.product_events
  FOR EACH ROW EXECUTE FUNCTION public.trg_update_product_counters();

-- ================================
-- RETENTION HELPER (optional cleanup, not scheduled automatically)
-- ================================
-- To prevent unbounded growth, old impression events can be periodically purged, e.g.:
-- DELETE FROM public.product_events WHERE event_type = 'impression' AND created_at < NOW() - INTERVAL '90 days';
