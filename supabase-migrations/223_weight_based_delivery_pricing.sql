-- ============================================================
-- Migration 223: Weight-based delivery pricing
-- ============================================================
-- Logistics companies price deliveries by weight. This migration adds:
--   1. products.weight_kg (+ optional dimensions for volumetric weight)
--   2. product_variants.weight_kg (multi-item products)
--   3. product_categories.default_weight_kg (fallback when vendor
--      does not declare a weight)
--   4. orders.total_weight_kg (authoritative order weight, computed
--      server-side at checkout; readable by the partner dashboard)
--
-- Pricing rules themselves stay in JSONB config columns:
--   verified_logistics_partners.pricing_config   (intrastate, per vehicle)
--   verified_logistics_partners.interstate_config (interstate/international)
-- New keys consumed by the backend (no schema change needed):
--   per_kg_rate, international_per_kg_rate, included_weight_kg,
--   max_weight_kg, fixed_price, mode
-- ============================================================

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(8,3) CHECK (weight_kg IS NULL OR weight_kg >= 0),
  ADD COLUMN IF NOT EXISTS length_cm NUMERIC(8,2) CHECK (length_cm IS NULL OR length_cm >= 0),
  ADD COLUMN IF NOT EXISTS width_cm  NUMERIC(8,2) CHECK (width_cm  IS NULL OR width_cm  >= 0),
  ADD COLUMN IF NOT EXISTS height_cm NUMERIC(8,2) CHECK (height_cm IS NULL OR height_cm >= 0);

COMMENT ON COLUMN public.products.weight_kg IS
  'Vendor-declared actual weight in kg. Drives chargeable weight for delivery pricing.';
COMMENT ON COLUMN public.products.length_cm IS
  'Optional package length in cm. With width+height enables volumetric weight (L*W*H/5000).';
COMMENT ON COLUMN public.products.width_cm IS
  'Optional package width in cm for volumetric weight.';
COMMENT ON COLUMN public.products.height_cm IS
  'Optional package height in cm for volumetric weight.';

ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(8,3) CHECK (weight_kg IS NULL OR weight_kg >= 0);

COMMENT ON COLUMN public.product_variants.weight_kg IS
  'Per-variant weight override; falls back to parent product weight when NULL.';

ALTER TABLE public.product_categories
  ADD COLUMN IF NOT EXISTS default_weight_kg NUMERIC(8,3) NOT NULL DEFAULT 1.0;

COMMENT ON COLUMN public.product_categories.default_weight_kg IS
  'Fallback weight used for delivery pricing when a product has no weight_kg.';

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS total_weight_kg NUMERIC(10,3);

COMMENT ON COLUMN public.orders.total_weight_kg IS
  'Server-computed chargeable weight of the whole order at checkout time.';

CREATE INDEX IF NOT EXISTS idx_products_weight_kg
  ON public.products(weight_kg) WHERE weight_kg IS NOT NULL;

-- Verify
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'weight_kg'
  ) THEN
    RAISE WARNING 'products.weight_kg was not created';
  ELSE
    RAISE NOTICE 'products.weight_kg created OK';
  END IF;
END $$;
