/**
 * Auction Category Entity Interface
 *
 * Represents the 6 main auction categories for discovery and organization
 */
export interface AuctionCategory {
  id: string;
  name: string;
  description: string;
  icon_name: string; // Ionicon name for mobile UI
  color: string; // Hex color code
  slug: string; // URL-friendly identifier
  display_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Category with auction count for discovery screen
 */
export interface AuctionCategoryWithStats extends AuctionCategory {
  auction_count: number;
  active_auction_count: number;
  featured_auctions?: AuctionPreview[];
}

/**
 * Minimal auction info for category previews
 */
export interface AuctionPreview {
  id: string;
  title: string;
  current_bid: number;
  starting_price: number;
  thumbnail_url?: string;
  time_status: 'upcoming' | 'active' | 'ended';
  seconds_remaining?: number;
  total_bids: number;
}