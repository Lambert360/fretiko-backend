BEGIN;

-- Migration 220: Expose seller catalog visibility flags on auction_summary
--
-- Why:
--   The auction_summary view is the read model for all auction list/detail
--   endpoints. Vendor catalog visibility (catalog_hidden / is_adult_content,
--   added in migration 219) must be filterable on this view so unlisted and
--   18+ sellers' auctions are excluded from discovery and gated on direct
--   links. PostgREST cannot filter inside the `seller` JSON column, so the
--   flags are exposed as flat columns: seller_catalog_hidden,
--   seller_is_adult_content.
--
-- Postgres CREATE OR REPLACE VIEW cannot insert a column mid-list, so drop
-- first (same pattern as migration 210).

DROP VIEW IF EXISTS public.auction_summary;

CREATE VIEW public.auction_summary AS
SELECT
  a.id,
  a.seller_id,
  a.category_id,
  a.title,
  a.description,
  a.lot_number,
  a.starting_price,
  a.reserve_price,
  a.current_bid,
  a.bid_increment,
  a.auction_type,
  a.start_time,
  a.end_time,
  a.soft_close_enabled,
  a.soft_close_extension,
  a.status,
  a.total_bids,
  a.unique_bidders,
  a.view_count,
  a.watch_count,
  a.winner_id,
  a.winning_bid,
  a.sale_completed,
  a.images,
  a.video_url,
  a.thumbnail_url,
  a.stream_url,
  a.current_item_id,
  a.auctioneer_enabled,
  a.crowd_sounds_enabled,
  a.listing_fee,
  a.commission_rate,
  a.buyer_premium_rate,
  a.created_at,
  a.updated_at,

  json_build_object(
    'id', u.id,
    'username', COALESCE(u.username, u.display_name),
    'avatar_url', u.avatar_url,
    'is_verified', COALESCE(u.is_verified, false)
  ) as seller,

  -- Flat visibility flags (filterable via PostgREST .eq())
  COALESCE(u.catalog_hidden, false) as seller_catalog_hidden,
  COALESCE(u.is_adult_content, false) as seller_is_adult_content,

  json_build_object(
    'id', c.id,
    'name', c.name,
    'icon_name', c.icon_name,
    'color', c.color,
    'slug', c.slug
  ) as category,

  c.slug as category_slug,

  CASE
    WHEN a.status = 'scheduled' AND a.start_time > NOW() THEN 'upcoming'
    WHEN a.status = 'active' AND a.end_time > NOW() THEN 'active'
    ELSE 'ended'
  END as time_status,

  CASE
    WHEN a.status = 'active' AND a.end_time > NOW() THEN
      EXTRACT(EPOCH FROM (a.end_time - NOW()))::integer
    ELSE
      0
  END as seconds_remaining,

  (
    SELECT json_build_object(
      'id', ab.id,
      'bidder_display_id', ab.bidder_display_id,
      'amount', ab.amount,
      'created_at', ab.created_at
    )
    FROM auction_bids ab
    WHERE ab.auction_id = a.id
      AND ab.is_winning = true
      AND ab.is_valid = true
    ORDER BY ab.amount DESC, ab.created_at ASC
    LIMIT 1
  ) as current_winning_bid

FROM auctions a
LEFT JOIN user_profiles u ON a.seller_id = u.id
LEFT JOIN auction_categories c ON a.category_id = c.id;

COMMENT ON VIEW public.auction_summary IS 'Auction summary with current_item_id and seller visibility flags (catalog_hidden, is_adult_content)';

-- Restore grants (dropped with the view)
GRANT SELECT ON public.auction_summary TO authenticated;
GRANT SELECT ON public.auction_summary TO anon;

COMMIT;
