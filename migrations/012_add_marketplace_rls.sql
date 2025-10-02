-- Migration: Add Marketplace RLS Policies
-- Date: 2025-01-28
-- Description: Row Level Security policies for marketplace system

-- ================================
-- ENABLE RLS ON ALL TABLES
-- ================================

ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_bookings ENABLE ROW LEVEL SECURITY;

-- ================================
-- CATEGORY POLICIES (PUBLIC READ)
-- ================================

-- Product categories - public read access
CREATE POLICY "Product categories are publicly readable" ON product_categories
    FOR SELECT USING (true);

-- Service categories - public read access
CREATE POLICY "Service categories are publicly readable" ON service_categories
    FOR SELECT USING (true);

-- ================================
-- PRODUCTS POLICIES
-- ================================

-- Anyone can view active products
CREATE POLICY "Active products are publicly readable" ON products
    FOR SELECT USING (
        status = 'active' 
        AND deleted_at IS NULL
    );

-- Sellers can view all their own products
CREATE POLICY "Sellers can view their own products" ON products
    FOR SELECT USING (user_id = auth.uid());

-- Only sellers can create products (if they have is_seller = true)
CREATE POLICY "Sellers can create products" ON products
    FOR INSERT WITH CHECK (
        user_id = auth.uid() 
        AND EXISTS (
            SELECT 1 FROM user_profiles 
            WHERE id = auth.uid() 
            AND is_seller = true
        )
    );

-- Sellers can update their own products
CREATE POLICY "Sellers can update their own products" ON products
    FOR UPDATE USING (user_id = auth.uid()) 
    WITH CHECK (user_id = auth.uid());

-- Sellers can delete their own products
CREATE POLICY "Sellers can delete their own products" ON products
    FOR DELETE USING (user_id = auth.uid());

-- ================================
-- SERVICES POLICIES
-- ================================

-- Anyone can view active services
CREATE POLICY "Active services are publicly readable" ON services
    FOR SELECT USING (
        status = 'active' 
        AND deleted_at IS NULL
    );

-- Service providers can view all their own services
CREATE POLICY "Providers can view their own services" ON services
    FOR SELECT USING (user_id = auth.uid());

-- Only service providers can create services (if they have is_rider = true)
CREATE POLICY "Providers can create services" ON services
    FOR INSERT WITH CHECK (
        user_id = auth.uid() 
        AND EXISTS (
            SELECT 1 FROM user_profiles 
            WHERE id = auth.uid() 
            AND is_rider = true
        )
    );

-- Service providers can update their own services
CREATE POLICY "Providers can update their own services" ON services
    FOR UPDATE USING (user_id = auth.uid()) 
    WITH CHECK (user_id = auth.uid());

-- Service providers can delete their own services
CREATE POLICY "Providers can delete their own services" ON services
    FOR DELETE USING (user_id = auth.uid());

-- ================================
-- RATINGS POLICIES
-- ================================

-- Anyone can read product ratings
CREATE POLICY "Product ratings are publicly readable" ON product_ratings
    FOR SELECT USING (true);

-- Users can create ratings for products (one per product)
CREATE POLICY "Users can create product ratings" ON product_ratings
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- Users can update their own ratings
CREATE POLICY "Users can update their own product ratings" ON product_ratings
    FOR UPDATE USING (user_id = auth.uid()) 
    WITH CHECK (user_id = auth.uid());

-- Users can delete their own ratings
CREATE POLICY "Users can delete their own product ratings" ON product_ratings
    FOR DELETE USING (user_id = auth.uid());

-- Same policies for service ratings
CREATE POLICY "Service ratings are publicly readable" ON service_ratings
    FOR SELECT USING (true);

CREATE POLICY "Users can create service ratings" ON service_ratings
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own service ratings" ON service_ratings
    FOR UPDATE USING (user_id = auth.uid()) 
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete their own service ratings" ON service_ratings
    FOR DELETE USING (user_id = auth.uid());

-- ================================
-- LIKES POLICIES
-- ================================

-- Anyone can read product likes (for counts)
CREATE POLICY "Product likes are publicly readable" ON product_likes
    FOR SELECT USING (true);

-- Users can create likes
CREATE POLICY "Users can like products" ON product_likes
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- Users can delete their own likes (unlike)
CREATE POLICY "Users can unlike products" ON product_likes
    FOR DELETE USING (user_id = auth.uid());

-- Same policies for service likes
CREATE POLICY "Service likes are publicly readable" ON service_likes
    FOR SELECT USING (true);

CREATE POLICY "Users can like services" ON service_likes
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can unlike services" ON service_likes
    FOR DELETE USING (user_id = auth.uid());

-- ================================
-- COMMENTS POLICIES
-- ================================

-- Anyone can read non-deleted comments
CREATE POLICY "Product comments are publicly readable" ON product_comments
    FOR SELECT USING (is_deleted = false);

-- Users can create comments
CREATE POLICY "Users can create product comments" ON product_comments
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- Users can update their own comments
CREATE POLICY "Users can update their own product comments" ON product_comments
    FOR UPDATE USING (user_id = auth.uid()) 
    WITH CHECK (user_id = auth.uid());

-- Users can delete their own comments (soft delete)
CREATE POLICY "Users can delete their own product comments" ON product_comments
    FOR UPDATE USING (user_id = auth.uid()) 
    WITH CHECK (user_id = auth.uid() AND is_deleted = true);

-- Same policies for service comments
CREATE POLICY "Service comments are publicly readable" ON service_comments
    FOR SELECT USING (is_deleted = false);

CREATE POLICY "Users can create service comments" ON service_comments
    FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own service comments" ON service_comments
    FOR UPDATE USING (user_id = auth.uid()) 
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete their own service comments" ON service_comments
    FOR UPDATE USING (user_id = auth.uid()) 
    WITH CHECK (user_id = auth.uid() AND is_deleted = true);

-- ================================
-- CART POLICIES
-- ================================

-- Users can only see their own cart items
CREATE POLICY "Users can view their own cart items" ON cart_items
    FOR SELECT USING (user_id = auth.uid());

-- Users can add items to their own cart
CREATE POLICY "Users can add to their own cart" ON cart_items
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- Users can update their own cart items
CREATE POLICY "Users can update their own cart items" ON cart_items
    FOR UPDATE USING (user_id = auth.uid()) 
    WITH CHECK (user_id = auth.uid());

-- Users can delete their own cart items
CREATE POLICY "Users can delete their own cart items" ON cart_items
    FOR DELETE USING (user_id = auth.uid());

-- ================================
-- SERVICE BOOKINGS POLICIES
-- ================================

-- Users can see their own bookings
CREATE POLICY "Users can view their own bookings" ON service_bookings
    FOR SELECT USING (user_id = auth.uid());

-- Service providers can see bookings for their services
CREATE POLICY "Providers can view bookings for their services" ON service_bookings
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM services 
            WHERE services.id = service_bookings.service_id 
            AND services.user_id = auth.uid()
        )
    );

-- Users can create bookings
CREATE POLICY "Users can create service bookings" ON service_bookings
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- Users can update their own bookings
CREATE POLICY "Users can update their own bookings" ON service_bookings
    FOR UPDATE USING (user_id = auth.uid()) 
    WITH CHECK (user_id = auth.uid());

-- Service providers can update bookings for their services
CREATE POLICY "Providers can update bookings for their services" ON service_bookings
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM services 
            WHERE services.id = service_bookings.service_id 
            AND services.user_id = auth.uid()
        )
    ) WITH CHECK (
        EXISTS (
            SELECT 1 FROM services 
            WHERE services.id = service_bookings.service_id 
            AND services.user_id = auth.uid()
        )
    );

-- ================================
-- HELPER FUNCTIONS FOR POLICIES
-- ================================

-- Note: Helper functions removed to avoid auth schema permissions issues
-- RLS policies use direct EXISTS queries instead

-- ================================
-- GRANT PUBLIC READ ACCESS
-- ================================

-- Grant read access to public for categories
GRANT SELECT ON product_categories TO anon;
GRANT SELECT ON service_categories TO anon;

-- Grant read access to public for active products and services
GRANT SELECT ON products TO anon;
GRANT SELECT ON services TO anon;
GRANT SELECT ON product_ratings TO anon;
GRANT SELECT ON service_ratings TO anon;
GRANT SELECT ON product_likes TO anon;
GRANT SELECT ON service_likes TO anon;
GRANT SELECT ON product_comments TO anon;
GRANT SELECT ON service_comments TO anon;

COMMIT;