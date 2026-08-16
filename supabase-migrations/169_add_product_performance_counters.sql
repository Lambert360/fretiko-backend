-- Migration 169: Add product performance counters for ranking
-- Adds click_count, impression_count, cart_add_count, sold_count, last_sold_at to products
-- Backfills sold_count/last_sold_at from existing order_items + orders data

-- ================================
-- ADD COLUMNS
-- ================================

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS click_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS impression_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cart_add_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sold_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_sold_at TIMESTAMPTZ;

COMMENT ON COLUMN public.products.click_count IS 'Number of times product card was clicked/tapped from a feed';
COMMENT ON COLUMN public.products.impression_count IS 'Number of times product card was rendered/seen in a feed';
COMMENT ON COLUMN public.products.cart_add_count IS 'Number of times product was added to cart';
COMMENT ON COLUMN public.products.sold_count IS 'Cumulative units sold across completed orders';
COMMENT ON COLUMN public.products.last_sold_at IS 'Timestamp of the most recent completed sale';

-- ================================
-- INDEXES
-- ================================

CREATE INDEX IF NOT EXISTS idx_products_sold_count ON public.products(sold_count DESC);
CREATE INDEX IF NOT EXISTS idx_products_last_sold_at ON public.products(last_sold_at DESC) WHERE last_sold_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_cart_add_count ON public.products(cart_add_count DESC);

-- ================================
-- BACKFILL sold_count / last_sold_at FROM order_items + orders
-- ================================

WITH sales AS (
  SELECT
    oi.product_id,
    SUM(oi.quantity) AS total_sold,
    MAX(o.created_at) AS last_sold
  FROM public.order_items oi
  JOIN public.orders o ON o.id = oi.order_id
  WHERE oi.product_id IS NOT NULL
    AND o.status IN ('completed', 'delivered')
  GROUP BY oi.product_id
)
UPDATE public.products p
SET sold_count = sales.total_sold,
    last_sold_at = sales.last_sold
FROM sales
WHERE p.id = sales.product_id;

-- ================================
-- BACKFILL cart_add_count FROM current cart_items (best-effort snapshot)
-- ================================

WITH cart_counts AS (
  SELECT product_id, COUNT(*) AS cnt
  FROM public.cart_items
  GROUP BY product_id
)
UPDATE public.products p
SET cart_add_count = cart_counts.cnt
FROM cart_counts
WHERE p.id = cart_counts.product_id;
