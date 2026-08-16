-- Migration 170: Create seller_stats table with real-time trigger updates
-- Provides trust/performance signals for product ranking (v1).
-- Uses a full-recalculation function (not deltas) triggered on every relevant
-- change so that a refund/dispute immediately tanks the seller's ranking.

-- ================================
-- TABLE
-- ================================

CREATE TABLE IF NOT EXISTS public.seller_stats (
  user_id UUID PRIMARY KEY REFERENCES public.user_profiles(id) ON DELETE CASCADE,

  completed_orders INTEGER NOT NULL DEFAULT 0,
  cancelled_orders INTEGER NOT NULL DEFAULT 0,
  refunded_orders INTEGER NOT NULL DEFAULT 0,

  total_revenue DECIMAL(18,6) NOT NULL DEFAULT 0,
  average_order_value DECIMAL(18,6) NOT NULL DEFAULT 0,

  dispute_count INTEGER NOT NULL DEFAULT 0,
  refund_rate DECIMAL(5,4) NOT NULL DEFAULT 0,   -- refunded / (completed + refunded)
  dispute_rate DECIMAL(5,4) NOT NULL DEFAULT 0,  -- disputes / completed

  avg_seller_rating DECIMAL(3,2) NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,

  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.seller_stats IS 'Real-time seller trust/performance signals for product ranking. Recalculated via triggers on orders, escrows, disputes, and ratings.';
COMMENT ON COLUMN public.seller_stats.refund_rate IS 'refunded_orders / (completed_orders + refunded_orders), 0..1';
COMMENT ON COLUMN public.seller_stats.dispute_rate IS 'dispute_count / completed_orders, 0..1';

CREATE INDEX IF NOT EXISTS idx_seller_stats_refund_rate ON public.seller_stats(refund_rate);
CREATE INDEX IF NOT EXISTS idx_seller_stats_dispute_rate ON public.seller_stats(dispute_rate);
CREATE INDEX IF NOT EXISTS idx_seller_stats_avg_rating ON public.seller_stats(avg_seller_rating DESC);

ALTER TABLE public.seller_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view seller stats"
ON public.seller_stats FOR SELECT
TO authenticated
USING (true);

CREATE POLICY "Service role can manage seller stats"
ON public.seller_stats FOR ALL
TO service_role
USING (true);

-- ================================
-- FULL RECALCULATION FUNCTION
-- ================================

CREATE OR REPLACE FUNCTION public.recalculate_seller_stats(p_user_id UUID)
RETURNS VOID AS $$
DECLARE
  v_completed_orders INTEGER := 0;
  v_cancelled_orders INTEGER := 0;
  v_refunded_orders INTEGER := 0;
  v_total_revenue DECIMAL(18,6) := 0;
  v_avg_order_value DECIMAL(18,6) := 0;
  v_dispute_count INTEGER := 0;
  v_refund_rate DECIMAL(5,4) := 0;
  v_dispute_rate DECIMAL(5,4) := 0;
  v_avg_rating DECIMAL(3,2) := 0;
  v_rating_count INTEGER := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Orders: completed / cancelled counts + revenue
  SELECT
    COUNT(*) FILTER (WHERE status = 'completed'),
    COUNT(*) FILTER (WHERE status = 'cancelled'),
    COALESCE(SUM(total_amount) FILTER (WHERE status = 'completed'), 0)
  INTO v_completed_orders, v_cancelled_orders, v_total_revenue
  FROM public.orders
  WHERE vendor_id = p_user_id;

  IF v_completed_orders > 0 THEN
    v_avg_order_value := v_total_revenue / v_completed_orders;
  END IF;

  -- Refunded orders: escrows in 'refunded' status tied to this vendor's orders
  SELECT COUNT(*)
  INTO v_refunded_orders
  FROM public.escrows e
  JOIN public.orders o ON o.id = e.order_id
  WHERE o.vendor_id = p_user_id
    AND e.status = 'refunded';

  -- Disputes where this user is the respondent (i.e. the seller being disputed)
  SELECT COUNT(*)
  INTO v_dispute_count
  FROM public.disputes
  WHERE respondent_id = p_user_id
    AND dispute_category = 'order_dispute';

  -- Rates
  IF (v_completed_orders + v_refunded_orders) > 0 THEN
    v_refund_rate := v_refunded_orders::DECIMAL / (v_completed_orders + v_refunded_orders);
  END IF;

  IF v_completed_orders > 0 THEN
    v_dispute_rate := LEAST(v_dispute_count::DECIMAL / v_completed_orders, 1);
  END IF;

  -- Average rating across product_ratings + service_ratings for this seller's listings
  SELECT
    COALESCE(AVG(rating), 0),
    COUNT(*)
  INTO v_avg_rating, v_rating_count
  FROM (
    SELECT pr.rating
    FROM public.product_ratings pr
    JOIN public.products p ON p.id = pr.product_id
    WHERE p.user_id = p_user_id
    UNION ALL
    SELECT sr.rating
    FROM public.service_ratings sr
    JOIN public.services s ON s.id = sr.service_id
    WHERE s.user_id = p_user_id
  ) all_ratings;

  INSERT INTO public.seller_stats (
    user_id, completed_orders, cancelled_orders, refunded_orders,
    total_revenue, average_order_value, dispute_count,
    refund_rate, dispute_rate, avg_seller_rating, rating_count, last_updated_at
  ) VALUES (
    p_user_id, v_completed_orders, v_cancelled_orders, v_refunded_orders,
    v_total_revenue, v_avg_order_value, v_dispute_count,
    v_refund_rate, v_dispute_rate, v_avg_rating, v_rating_count, NOW()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    completed_orders = EXCLUDED.completed_orders,
    cancelled_orders = EXCLUDED.cancelled_orders,
    refunded_orders = EXCLUDED.refunded_orders,
    total_revenue = EXCLUDED.total_revenue,
    average_order_value = EXCLUDED.average_order_value,
    dispute_count = EXCLUDED.dispute_count,
    refund_rate = EXCLUDED.refund_rate,
    dispute_rate = EXCLUDED.dispute_rate,
    avg_seller_rating = EXCLUDED.avg_seller_rating,
    rating_count = EXCLUDED.rating_count,
    last_updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ================================
-- TRIGGER WRAPPERS
-- ================================

-- Orders: recalc vendor stats when status changes
CREATE OR REPLACE FUNCTION public.trg_seller_stats_from_orders()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') OR (TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status) THEN
    BEGIN
      PERFORM public.recalculate_seller_stats(NEW.vendor_id);
    EXCEPTION WHEN OTHERS THEN
      -- Never let a ranking-stats failure roll back the order write itself
      RAISE WARNING 'seller_stats recalculation failed for vendor %: %', NEW.vendor_id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS seller_stats_orders_trigger ON public.orders;
CREATE TRIGGER seller_stats_orders_trigger
  AFTER INSERT OR UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.trg_seller_stats_from_orders();

-- Escrows: recalc vendor stats when status changes (e.g. refunded)
CREATE OR REPLACE FUNCTION public.trg_seller_stats_from_escrows()
RETURNS TRIGGER AS $$
DECLARE
  v_vendor_id UUID;
BEGIN
  IF (TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status) OR TG_OP = 'INSERT' THEN
    SELECT vendor_id INTO v_vendor_id FROM public.orders WHERE id = NEW.order_id;
    IF v_vendor_id IS NOT NULL THEN
      BEGIN
        PERFORM public.recalculate_seller_stats(v_vendor_id);
      EXCEPTION WHEN OTHERS THEN
        -- Never let a ranking-stats failure roll back the escrow write itself
        RAISE WARNING 'seller_stats recalculation failed for vendor %: %', v_vendor_id, SQLERRM;
      END;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS seller_stats_escrows_trigger ON public.escrows;
CREATE TRIGGER seller_stats_escrows_trigger
  AFTER INSERT OR UPDATE OF status ON public.escrows
  FOR EACH ROW EXECUTE FUNCTION public.trg_seller_stats_from_escrows();

-- Disputes: recalc respondent (seller) stats on insert/status/resolution change
CREATE OR REPLACE FUNCTION public.trg_seller_stats_from_disputes()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.respondent_id IS NOT NULL AND NEW.dispute_category = 'order_dispute' THEN
    IF TG_OP = 'INSERT'
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.resolution IS DISTINCT FROM OLD.resolution THEN
      BEGIN
        PERFORM public.recalculate_seller_stats(NEW.respondent_id);
      EXCEPTION WHEN OTHERS THEN
        -- Never let a ranking-stats failure roll back the dispute write itself
        -- (e.g. respondent_id not yet present in user_profiles for edge-case accounts)
        RAISE WARNING 'seller_stats recalculation failed for respondent %: %', NEW.respondent_id, SQLERRM;
      END;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS seller_stats_disputes_trigger ON public.disputes;
CREATE TRIGGER seller_stats_disputes_trigger
  AFTER INSERT OR UPDATE ON public.disputes
  FOR EACH ROW EXECUTE FUNCTION public.trg_seller_stats_from_disputes();

-- Product ratings: recalc the product owner's (seller's) avg rating
CREATE OR REPLACE FUNCTION public.trg_seller_stats_from_product_ratings()
RETURNS TRIGGER AS $$
DECLARE
  v_seller_id UUID;
BEGIN
  SELECT user_id INTO v_seller_id FROM public.products WHERE id = COALESCE(NEW.product_id, OLD.product_id);
  IF v_seller_id IS NOT NULL THEN
    BEGIN
      PERFORM public.recalculate_seller_stats(v_seller_id);
    EXCEPTION WHEN OTHERS THEN
      -- Never let a ranking-stats failure roll back the review write itself
      RAISE WARNING 'seller_stats recalculation failed for seller %: %', v_seller_id, SQLERRM;
    END;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS seller_stats_product_ratings_trigger ON public.product_ratings;
CREATE TRIGGER seller_stats_product_ratings_trigger
  AFTER INSERT OR UPDATE OR DELETE ON public.product_ratings
  FOR EACH ROW EXECUTE FUNCTION public.trg_seller_stats_from_product_ratings();

-- Service ratings: recalc the service owner's (seller's) avg rating
CREATE OR REPLACE FUNCTION public.trg_seller_stats_from_service_ratings()
RETURNS TRIGGER AS $$
DECLARE
  v_seller_id UUID;
BEGIN
  SELECT user_id INTO v_seller_id FROM public.services WHERE id = COALESCE(NEW.service_id, OLD.service_id);
  IF v_seller_id IS NOT NULL THEN
    BEGIN
      PERFORM public.recalculate_seller_stats(v_seller_id);
    EXCEPTION WHEN OTHERS THEN
      -- Never let a ranking-stats failure roll back the review write itself
      RAISE WARNING 'seller_stats recalculation failed for seller %: %', v_seller_id, SQLERRM;
    END;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS seller_stats_service_ratings_trigger ON public.service_ratings;
CREATE TRIGGER seller_stats_service_ratings_trigger
  AFTER INSERT OR UPDATE OR DELETE ON public.service_ratings
  FOR EACH ROW EXECUTE FUNCTION public.trg_seller_stats_from_service_ratings();

-- ================================
-- BACKFILL EXISTING SELLERS
-- ================================

DO $$
DECLARE
  seller RECORD;
BEGIN
  FOR seller IN
    SELECT DISTINCT user_id FROM (
      SELECT vendor_id AS user_id FROM public.orders WHERE vendor_id IS NOT NULL
      UNION
      SELECT user_id FROM public.products
      UNION
      SELECT user_id FROM public.services
    ) sellers
  LOOP
    BEGIN
      PERFORM public.recalculate_seller_stats(seller.user_id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'seller_stats backfill failed for %: %', seller.user_id, SQLERRM;
    END;
  END LOOP;
END $$;
