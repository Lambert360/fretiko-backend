/**
 * Auction Item Entity Interface
 *
 * Represents individual items within a multi-item live auction
 */
export interface AuctionItem {
  id: string;
  auction_id: string;

  // Item Information
  title: string;
  description?: string;
  lot_number?: string;
  starting_price: number;
  reserve_price?: number;
  current_bid: number;
  bid_increment: number;

  // Item Status & Timing
  bidding_status: 'waiting' | 'countdown' | 'active' | 'ended' | 'sold' | 'passed';
  order_in_auction: number;
  bidding_duration: number; // seconds for active bidding

  // Timestamps
  countdown_started_at?: Date;
  bidding_started_at?: Date;
  bidding_ended_at?: Date;

  // Media
  images: string[];
  video_url?: string;

  // Winner Information
  winner_id?: string;
  winning_bid?: number;

  // Metadata
  created_at: Date;
  updated_at: Date;
}

/**
 * Auction Item with auction details for API responses
 */
export interface AuctionItemWithDetails extends AuctionItem {
  auction: {
    id: string;
    title: string;
    seller_id: string;
  };
  winner?: {
    id: string;
    username: string;
    avatar_url?: string;
  };
}

