-- =====================================================
-- Migration: 219
-- Vendor-level catalog visibility flags.
--
-- catalog_hidden = "unlisted store": the vendor's products and
-- services are excluded from all discovery surfaces (feeds,
-- search, browse, public store catalog) but remain purchasable
-- via direct link — matching Shopify's UNLISTED semantics.
-- Use cases: link-only/exclusive selling, soft-launch vendors,
-- referral-only providers.
--
-- is_adult_content = 18+ catalog flag: the vendor's items are
-- hidden from viewers who are not verified 18+ (based on
-- user_profiles.date_of_birth), and direct links to their
-- products/services are gated the same way.
--
-- Both flags live on user_profiles (vendor level), NOT on
-- products/services status — so they compose cleanly with
-- active/inactive/removed and toggling is instantly reversible.
-- =====================================================

BEGIN;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS catalog_hidden BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS is_adult_content BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_profiles.catalog_hidden IS
  'When true, vendor products/services are excluded from discovery surfaces but remain accessible via direct link (unlisted store).';

COMMENT ON COLUMN public.user_profiles.is_adult_content IS
  'When true, vendor catalog is gated to viewers verified 18+ via date_of_birth.';

COMMIT;
