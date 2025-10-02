/**
 * Auction Bid Entity Interface
 *
 * Represents auction bids with support for manual, proxy, and auto bidding
 */
export interface AuctionBid {
  id: string;
  auction_id: string;
  bidder_id: string;

  // Bid Details
  amount: number;
  bid_type: 'manual' | 'proxy' | 'auto';

  // Proxy Bidding
  max_bid_amount?: number;
  is_proxy_bid: boolean;
  proxy_bid_parent_id?: string;

  // Bid Status
  is_winning: boolean;
  is_valid: boolean;

  // Anonymous Display
  bidder_display_id: string; // e.g., "Bidder #47"

  // Security & Audit
  ip_address?: string;
  user_agent?: string;
  created_at: Date;
}

/**
 * Bid with bidder information for display
 */
export interface AuctionBidWithBidder extends AuctionBid {
  bidder?: {
    id: string;
    username: string;
    avatar_url?: string;
    is_verified: boolean;
  };
}

/**
 * Bid history item for public display (anonymized)
 */
export interface PublicBidHistoryItem {
  id: string;
  amount: number;
  bidder_display_id: string;
  is_winning: boolean;
  created_at: Date;
  bid_type: 'manual' | 'proxy' | 'auto';
}