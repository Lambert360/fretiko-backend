-- Migration: Create auction_summary view
-- This view provides a comprehensive summary of auctions with seller and category details

-- Drop view if exists
DROP VIEW IF EXISTS public.auction_summary;

-- Create auction_summary view
CREATE OR REPLACE VIEW public.auction_summary AS
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
  a.auctioneer_enabled,
  a.crowd_sounds_enabled,
  a.listing_fee,
  a.commission_rate,
  a.buyer_premium_rate,
  a.created_at,
  a.updated_at,

  -- Seller details
  json_build_object(
    'id', u.id,
    'username', u.username,
    'avatar_url', u.avatar_url,
    'is_verified', COALESCE(u.is_verified, false)
  ) as seller,

  -- Category details
  json_build_object(
    'id', c.id,
    'name', c.name,
    'icon_name', c.icon_name,
    'color', c.color,
    'slug', c.slug
  ) as category,

  -- Category slug for filtering
  c.slug as category_slug,

  -- Time status calculation
  CASE
    WHEN a.status = 'scheduled' AND a.start_time > NOW() THEN 'upcoming'
    WHEN a.status = 'active' AND a.end_time > NOW() THEN 'active'
    ELSE 'ended'
  END as time_status,

  -- Seconds remaining calculation
  CASE
    WHEN a.status = 'active' AND a.end_time > NOW() THEN
      EXTRACT(EPOCH FROM (a.end_time - NOW()))::integer
    ELSE
      0
  END as seconds_remaining,

  -- Current winning bid details (if exists)
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

-- Add comment
COMMENT ON VIEW public.auction_summary IS 'Comprehensive auction summary with seller, category, and bidding details';

-- Grant permissions
GRANT SELECT ON public.auction_summary TO authenticated;
GRANT SELECT ON public.auction_summary TO anon;
