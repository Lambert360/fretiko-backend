/**
 * Auction Entity Interface
 *
 * Represents the main auction table structure for TypeScript type safety
 */
export interface Auction {
  id: string;
  seller_id: string;
  category_id: string;

  // Basic Info
  title: string;
  description: string;
  lot_number?: string;

  // Pricing
  starting_price: number;
  reserve_price?: number;
  current_bid: number;
  bid_increment: number;

  // Auction Type & Timing
  auction_type: 'timed' | 'live';
  start_time: Date;
  end_time: Date;
  soft_close_enabled: boolean;
  soft_close_extension: number;

  // Status & Statistics
  status: 'scheduled' | 'active' | 'ended' | 'cancelled' | 'sold';
  total_bids: number;
  unique_bidders: number;
  view_count: number;
  watch_count: number;

  // Winner Information
  winner_id?: string;
  winning_bid?: number;
  sale_completed: boolean;

  // Media
  images: string[];
  video_url?: string;
  thumbnail_url?: string;

  // Live Auction Features
  stream_url?: string;
  auctioneer_enabled: boolean;
  crowd_sounds_enabled: boolean;

  // Fees & Commission
  listing_fee: number;
  commission_rate: number;
  buyer_premium_rate: number;

  // Metadata
  created_at: Date;
  updated_at: Date;
}

/**
 * Auction with populated relationships for API responses
 */
export interface AuctionWithDetails extends Auction {
  // Seller info
  seller: {
    id: string;
    username: string;
    avatar_url?: string;
    is_verified: boolean;
  };

  // Category info
  category: {
    id: string;
    name: string;
    icon_name: string;
    color: string;
    slug: string;
  };

  // Current winning bid info
  current_winning_bid?: {
    id: string;
    bidder_display_id: string;
    amount: number;
    created_at: Date;
  };

  // Time calculations
  time_status: 'upcoming' | 'active' | 'ended';
  seconds_remaining?: number;
  is_watched_by_user?: boolean;
  user_has_bid?: boolean;
}