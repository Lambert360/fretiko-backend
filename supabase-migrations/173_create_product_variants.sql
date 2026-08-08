-- Migration 173: Multi-item product video ads (product_variants)
-- Allows a single product upload (typically an advert video) to showcase
-- multiple sub-items, each with its own name, price, and media (image or video).
-- The main product row still stores the advert video/image and shared fields
-- (description, category, shipping, tags, etc). Individual variants override
-- name/price/media only.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_multi_item BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  media_url TEXT NOT NULL,
  media_type VARCHAR(10) NOT NULL CHECK (media_type IN ('image', 'video')),
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.product_variants IS 'Sub-items for a multi-item product video ad. Each variant has its own name/price/media, sharing the parent product description, category, shipping, and tags.';

CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON public.product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_product_variants_sort_order ON public.product_variants(product_id, sort_order);

ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view product variants"
ON public.product_variants FOR SELECT
TO authenticated, anon
USING (true);

CREATE POLICY "Service role can manage all product variants"
ON public.product_variants FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Track which variant (if any) a cart item refers to, and snapshot its name
-- so cart/order history remains accurate even if the variant is later edited/removed.
ALTER TABLE public.cart_items
  ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES public.product_variants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS variant_name VARCHAR(150);

CREATE INDEX IF NOT EXISTS idx_cart_items_variant_id ON public.cart_items(variant_id);
