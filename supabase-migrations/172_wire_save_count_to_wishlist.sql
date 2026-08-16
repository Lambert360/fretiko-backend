-- Migration 172: Wire products.save_count to wishlist inserts/deletes
-- save_count was defined on products but never updated by any trigger.

CREATE OR REPLACE FUNCTION public.trg_update_product_save_count()
RETURNS TRIGGER AS $$
BEGIN
  BEGIN
    IF TG_OP = 'INSERT' THEN
      UPDATE public.products SET save_count = save_count + 1 WHERE id = NEW.product_id;
    ELSIF TG_OP = 'DELETE' THEN
      UPDATE public.products SET save_count = GREATEST(save_count - 1, 0) WHERE id = OLD.product_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Never let a counter-update failure roll back the wishlist add/remove itself
    RAISE WARNING 'product save_count update failed for product %: %', COALESCE(NEW.product_id, OLD.product_id), SQLERRM;
  END;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wishlist_save_count_trigger ON public.wishlist;
CREATE TRIGGER wishlist_save_count_trigger
  AFTER INSERT OR DELETE ON public.wishlist
  FOR EACH ROW EXECUTE FUNCTION public.trg_update_product_save_count();

-- ================================
-- BACKFILL EXISTING save_count FROM CURRENT WISHLIST ROWS
-- ================================

WITH wishlist_counts AS (
  SELECT product_id, COUNT(*) AS cnt
  FROM public.wishlist
  GROUP BY product_id
)
UPDATE public.products p
SET save_count = wishlist_counts.cnt
FROM wishlist_counts
WHERE p.id = wishlist_counts.product_id;

-- Products with no wishlist rows should be 0 (in case save_count was previously non-zero/stale)
UPDATE public.products
SET save_count = 0
WHERE id NOT IN (SELECT DISTINCT product_id FROM public.wishlist)
  AND save_count != 0;
