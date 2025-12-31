-- Migration: Auction Management Upgrades
-- Date: 2025-01-29
-- Description: Add support for bid invalidation, auction disputes, and admin fraud detection tools

BEGIN;

-- ================================
-- STEP 1: ADD BID INVALIDATION COLUMNS
-- ================================

ALTER TABLE auction_bids ADD COLUMN IF NOT EXISTS invalidation_reason TEXT;
ALTER TABLE auction_bids ADD COLUMN IF NOT EXISTS invalidated_by UUID REFERENCES user_profiles(id);
ALTER TABLE auction_bids ADD COLUMN IF NOT EXISTS invalidated_at TIMESTAMP WITH TIME ZONE;

-- Create index for finding invalidated bids
CREATE INDEX IF NOT EXISTS idx_auction_bids_invalidated ON auction_bids(invalidated_at) WHERE invalidated_at IS NOT NULL;

-- ================================
-- STEP 2: EXTEND DISPUTES TABLE FOR AUCTIONS
-- ================================

-- Add auction_id column to disputes table if it doesn't exist
ALTER TABLE disputes ADD COLUMN IF NOT EXISTS auction_id UUID REFERENCES auctions(id) ON DELETE CASCADE;

-- Create index for auction disputes
CREATE INDEX IF NOT EXISTS idx_disputes_auction_id ON disputes(auction_id) WHERE auction_id IS NOT NULL;

-- Update dispute_category check constraint to include auction_dispute
DO $$
BEGIN
    -- Drop existing constraint if it exists
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'disputes_dispute_category_check'
    ) THEN
        ALTER TABLE disputes DROP CONSTRAINT disputes_dispute_category_check;
    END IF;
    
    -- Create new constraint with auction_dispute
    ALTER TABLE disputes ADD CONSTRAINT disputes_dispute_category_check 
        CHECK (dispute_category IN ('order_dispute', 'auction_dispute', 'bug_report', 'general'));
END $$;

-- Update dispute_type check constraint to include auction-specific types
DO $$
BEGIN
    -- Drop existing constraint if it exists
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'disputes_dispute_type_check'
    ) THEN
        ALTER TABLE disputes DROP CONSTRAINT disputes_dispute_type_check;
    END IF;
    
    -- Create new constraint with auction dispute types
    ALTER TABLE disputes ADD CONSTRAINT disputes_dispute_type_check 
        CHECK (dispute_type IN (
            -- Order dispute types
            'item_not_received', 'item_not_as_described', 'damaged_item', 
            'wrong_item', 'refund_request', 'quality_issue', 'delivery_issue',
            -- Auction dispute types
            'auction_winner_no_payment', 'auction_item_not_as_described',
            'auction_seller_no_ship', 'auction_buyer_remorse',
            'auction_shill_bidding', 'auction_bid_manipulation',
            -- Bug report types
            'app_crash', 'payment_issue', 'login_issue', 
            'feature_not_working', 'performance_issue',
            -- General
            'other'
        ));
END $$;

-- ================================
-- STEP 3: ADD FRAUD DETECTION METADATA
-- ================================

-- Add metadata index for auction fraud queries
CREATE INDEX IF NOT EXISTS idx_risk_flags_metadata_auction 
ON risk_flags USING gin(metadata) 
WHERE flag_type = 'fraud_investigation';

-- ================================
-- STEP 4: AUDIT LOGGING FOR AUCTION ACTIONS
-- ================================

-- Document new auction-specific audit action types:
-- - 'view_auction_bids' - Admin viewed full bid history
-- - 'invalidate_bid' - Admin invalidated a bid
-- - 'emergency_extend_auction' - Admin extended auction for technical reasons
-- - 'update_category' - Admin updated auction category

COMMENT ON COLUMN staff_audit_logs.action IS 
'Audit action type. Includes: view_auction_bids, invalidate_bid, emergency_extend_auction, update_category, and other standard actions';

-- ================================
-- STEP 5: CREATE VIEW FOR ADMIN BID HISTORY
-- ================================

-- Create a view that joins bids with full user details for admin use
CREATE OR REPLACE VIEW admin_auction_bids_view AS
SELECT 
    ab.id,
    ab.auction_id,
    ab.bidder_id,
    ab.amount,
    ab.bid_type,
    ab.max_bid_amount,
    ab.is_proxy_bid,
    ab.proxy_bid_parent_id,
    ab.is_winning,
    ab.is_valid,
    ab.bidder_display_id,
    ab.ip_address,
    ab.user_agent,
    ab.created_at,
    ab.invalidation_reason,
    ab.invalidated_by,
    ab.invalidated_at,
    -- Bidder details (only columns that exist in user_profiles)
    up.username as bidder_username,
    up.phone as bidder_phone,
    up.avatar_url as bidder_avatar_url,
    up.is_verified as bidder_is_verified,
    up.bio as bidder_bio,
    up.location as bidder_location,
    -- Invalidator details (if applicable)
    inv.username as invalidated_by_username
FROM auction_bids ab
LEFT JOIN user_profiles up ON ab.bidder_id = up.id
LEFT JOIN user_profiles inv ON ab.invalidated_by = inv.id;

COMMENT ON VIEW admin_auction_bids_view IS 
'Admin-only view of auction bids with full user identities for fraud detection and dispute resolution';

COMMIT;

-- Log completion
DO $$
BEGIN
    RAISE NOTICE 'Migration 085_auction_management_upgrades.sql completed successfully';
    RAISE NOTICE 'Added: Bid invalidation columns, auction dispute support, admin bid view';
END $$;


