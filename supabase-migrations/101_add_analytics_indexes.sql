-- Migration: Add indexes for analytics queries
-- Description: Optimize analytics queries with proper indexes
-- Date: 2025-01-XX

-- ================================
-- ORDERS TABLE INDEXES
-- ================================

-- Index for vendor orders by date range
CREATE INDEX IF NOT EXISTS idx_orders_vendor_created 
ON orders(vendor_id, created_at DESC);

-- Index for rider orders by date range
CREATE INDEX IF NOT EXISTS idx_orders_rider_created 
ON orders(rider_id, created_at DESC) 
WHERE rider_id IS NOT NULL;

-- Index for buyer orders by date range
-- Note: orders table uses buyer_id, not customer_id
CREATE INDEX IF NOT EXISTS idx_orders_buyer_created 
ON orders(buyer_id, created_at DESC);

-- Index for orders by status and date
CREATE INDEX IF NOT EXISTS idx_orders_status_created 
ON orders(status, created_at DESC);

-- ================================
-- LIVE STREAM TRANSACTIONS INDEXES
-- ================================

-- Index for vendor live stream transactions
CREATE INDEX IF NOT EXISTS idx_live_stream_transactions_vendor_created 
ON live_stream_transactions(vendor_id, created_at DESC);

-- Index for rider live stream transactions
CREATE INDEX IF NOT EXISTS idx_live_stream_transactions_rider_created 
ON live_stream_transactions(rider_id, created_at DESC) 
WHERE rider_id IS NOT NULL;

-- Index for buyer live stream transactions
CREATE INDEX IF NOT EXISTS idx_live_stream_transactions_buyer_created 
ON live_stream_transactions(buyer_id, created_at DESC);

-- Index for stream_id lookups
CREATE INDEX IF NOT EXISTS idx_live_stream_transactions_stream_id 
ON live_stream_transactions(stream_id) 
WHERE stream_id IS NOT NULL;

-- ================================
-- AUCTION SALES INDEXES
-- ================================

-- Index for seller auction sales
CREATE INDEX IF NOT EXISTS idx_auction_sales_seller_created 
ON auction_sales(seller_id, created_at DESC);

-- Index for buyer auction sales
CREATE INDEX IF NOT EXISTS idx_auction_sales_buyer_created 
ON auction_sales(buyer_id, created_at DESC) 
WHERE buyer_id IS NOT NULL;

-- Index for payment status
CREATE INDEX IF NOT EXISTS idx_auction_sales_payment_status 
ON auction_sales(payment_status, created_at DESC);

-- ================================
-- SERVICE BOOKINGS INDEXES
-- ================================

-- Index for service bookings by user
-- Note: service_bookings table uses user_id, not customer_id
CREATE INDEX IF NOT EXISTS idx_service_bookings_user_created 
ON service_bookings(user_id, created_at DESC);

-- Index for service bookings by status
CREATE INDEX IF NOT EXISTS idx_service_bookings_status_created 
ON service_bookings(status, created_at DESC);

-- ================================
-- ORDER ITEMS INDEXES
-- ================================

-- Index for order items by product and category
CREATE INDEX IF NOT EXISTS idx_order_items_product_category 
ON order_items(product_id, category) 
WHERE product_id IS NOT NULL;

-- Index for order items by order_id (for joins)
CREATE INDEX IF NOT EXISTS idx_order_items_order_id 
ON order_items(order_id);

-- ================================
-- LIVE STREAM GIFTS INDEXES
-- ================================

-- Index for live stream gifts by stream
CREATE INDEX IF NOT EXISTS idx_live_stream_gifts_stream_created 
ON live_stream_gifts(stream_id, created_at DESC);

-- Index for live stream gifts by sender
CREATE INDEX IF NOT EXISTS idx_live_stream_gifts_sender_created 
ON live_stream_gifts(sender_id, created_at DESC);

-- ================================
-- LIVE STREAMS INDEXES
-- ================================

-- Index for live streams by vendor and date
CREATE INDEX IF NOT EXISTS idx_live_streams_vendor_created 
ON live_streams(vendor_id, created_at DESC);

-- Index for live streams by status
CREATE INDEX IF NOT EXISTS idx_live_streams_status_created 
ON live_streams(status, created_at DESC);

-- ================================
-- PRODUCT RATINGS INDEXES
-- ================================

-- Index for product ratings by product
CREATE INDEX IF NOT EXISTS idx_product_ratings_product_id 
ON product_ratings(product_id);

-- ================================
-- ORDER ITEM RATINGS INDEXES
-- ================================

-- NOTE: order_item_ratings table does not exist in the current schema.
-- The database uses product_ratings and service_ratings instead.
-- If order_item_ratings table is created in the future, uncomment these indexes:
-- CREATE INDEX IF NOT EXISTS idx_order_item_ratings_order_id 
-- ON order_item_ratings(order_id);
-- CREATE INDEX IF NOT EXISTS idx_order_item_ratings_user_id 
-- ON order_item_ratings(user_id);

-- ================================
-- COMMENTS
-- ================================

COMMENT ON INDEX idx_orders_vendor_created IS 'Optimizes vendor order queries by date range';
COMMENT ON INDEX idx_orders_rider_created IS 'Optimizes rider order queries by date range';
COMMENT ON INDEX idx_orders_buyer_created IS 'Optimizes buyer order queries by date range';
COMMENT ON INDEX idx_live_stream_transactions_vendor_created IS 'Optimizes vendor live stream transaction queries';
COMMENT ON INDEX idx_auction_sales_seller_created IS 'Optimizes seller auction sales queries';
COMMENT ON INDEX idx_order_items_product_category IS 'Optimizes product analytics queries';
COMMENT ON INDEX idx_service_bookings_user_created IS 'Optimizes service booking queries by user and date range';

