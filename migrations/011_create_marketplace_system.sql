-- Migration: Create Marketplace System
-- Date: 2025-01-28  
-- Description: Complete e-commerce system for products and services with ratings, likes, comments, and cart

-- ================================
-- CATEGORIES TABLES
-- ================================

-- Product categories
CREATE TABLE product_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    icon_name VARCHAR(50),
    color_hex VARCHAR(7),
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Service categories  
CREATE TABLE service_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    icon_name VARCHAR(50),
    color_hex VARCHAR(7),
    sort_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================
-- PRODUCTS TABLE
-- ================================

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES product_categories(id),
    name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    price DECIMAL(10,2) NOT NULL CHECK (price >= 0),
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
    condition VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (condition IN ('new', 'like-new', 'good', 'fair')),
    
    -- Media and assets
    images TEXT[] DEFAULT '{}',
    primary_image_url TEXT,
    
    -- Location and shipping
    location TEXT,
    shipping_options JSONB DEFAULT '{"pickup": false, "delivery": false, "shipping": false}',
    
    -- SEO and discovery
    tags TEXT[] DEFAULT '{}',
    search_vector TSVECTOR,
    
    -- Status and visibility
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'sold', 'inactive')),
    is_featured BOOLEAN DEFAULT false,
    featured_until TIMESTAMP WITH TIME ZONE,
    
    -- Analytics
    view_count INTEGER DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    save_count INTEGER DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- ================================
-- SERVICES TABLE
-- ================================

CREATE TABLE services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES service_categories(id),
    name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    base_price DECIMAL(10,2) NOT NULL CHECK (base_price >= 0),
    duration VARCHAR(100),
    
    -- Media and assets
    images TEXT[] DEFAULT '{}',
    videos TEXT[] DEFAULT '{}',
    primary_media_url TEXT,
    media_type VARCHAR(10) DEFAULT 'image' CHECK (media_type IN ('image', 'video')),
    
    -- Location and availability
    location TEXT,
    service_area TEXT,
    availability JSONB DEFAULT '{"weekdays": false, "weekends": false, "evenings": false, "emergency": false}',
    
    -- SEO and discovery
    tags TEXT[] DEFAULT '{}',
    search_vector TSVECTOR,
    
    -- Status and visibility
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'busy', 'inactive')),
    is_featured BOOLEAN DEFAULT false,
    featured_until TIMESTAMP WITH TIME ZONE,
    
    -- Analytics
    view_count INTEGER DEFAULT 0,
    like_count INTEGER DEFAULT 0,
    save_count INTEGER DEFAULT 0,
    booking_count INTEGER DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- ================================
-- RATINGS AND REVIEWS
-- ================================

CREATE TABLE product_ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    review TEXT,
    images TEXT[] DEFAULT '{}',
    helpful_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(product_id, user_id)
);

CREATE TABLE service_ratings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    review TEXT,
    images TEXT[] DEFAULT '{}',
    helpful_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(service_id, user_id)
);

-- ================================
-- LIKES SYSTEM
-- ================================

CREATE TABLE product_likes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(product_id, user_id)
);

CREATE TABLE service_likes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(service_id, user_id)
);

-- ================================
-- COMMENTS SYSTEM
-- ================================

CREATE TABLE product_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    parent_comment_id UUID REFERENCES product_comments(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    like_count INTEGER DEFAULT 0,
    reply_count INTEGER DEFAULT 0,
    is_deleted BOOLEAN DEFAULT false,
    deleted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE service_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    parent_comment_id UUID REFERENCES service_comments(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    like_count INTEGER DEFAULT 0,
    reply_count INTEGER DEFAULT 0,
    is_deleted BOOLEAN DEFAULT false,
    deleted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ================================
-- CART SYSTEM
-- ================================

CREATE TABLE cart_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    price_at_add DECIMAL(10,2) NOT NULL,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, product_id)
);

-- ================================
-- SERVICE BOOKINGS
-- ================================

CREATE TABLE service_bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    requested_date TIMESTAMP WITH TIME ZONE,
    requested_duration VARCHAR(100),
    location TEXT,
    special_requests TEXT,
    quoted_price DECIMAL(10,2),
    final_price DECIMAL(10,2),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'confirmed', 'in_progress', 'completed', 'cancelled', 'rejected')
    ),
    provider_notes TEXT,
    user_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    confirmed_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- ================================
-- INDEXES FOR PERFORMANCE
-- ================================

-- Products indexes
CREATE INDEX idx_products_user_id ON products(user_id);
CREATE INDEX idx_products_category_id ON products(category_id);
CREATE INDEX idx_products_status ON products(status);
CREATE INDEX idx_products_created_at ON products(created_at DESC);
CREATE INDEX idx_products_featured ON products(is_featured, featured_until) WHERE is_featured = true;
CREATE INDEX idx_products_search ON products USING gin(search_vector);

-- Services indexes
CREATE INDEX idx_services_user_id ON services(user_id);
CREATE INDEX idx_services_category_id ON services(category_id);
CREATE INDEX idx_services_status ON services(status);
CREATE INDEX idx_services_created_at ON services(created_at DESC);
CREATE INDEX idx_services_featured ON services(is_featured, featured_until) WHERE is_featured = true;
CREATE INDEX idx_services_search ON services USING gin(search_vector);

-- Ratings indexes
CREATE INDEX idx_product_ratings_product_id ON product_ratings(product_id);
CREATE INDEX idx_product_ratings_user_id ON product_ratings(user_id);
CREATE INDEX idx_service_ratings_service_id ON service_ratings(service_id);
CREATE INDEX idx_service_ratings_user_id ON service_ratings(user_id);

-- Likes indexes
CREATE INDEX idx_product_likes_product_id ON product_likes(product_id);
CREATE INDEX idx_product_likes_user_id ON product_likes(user_id);
CREATE INDEX idx_service_likes_service_id ON service_likes(service_id);
CREATE INDEX idx_service_likes_user_id ON service_likes(user_id);

-- Comments indexes
CREATE INDEX idx_product_comments_product_id ON product_comments(product_id);
CREATE INDEX idx_product_comments_user_id ON product_comments(user_id);
CREATE INDEX idx_product_comments_parent ON product_comments(parent_comment_id);
CREATE INDEX idx_service_comments_service_id ON service_comments(service_id);
CREATE INDEX idx_service_comments_user_id ON service_comments(user_id);
CREATE INDEX idx_service_comments_parent ON service_comments(parent_comment_id);

-- Cart and bookings indexes
CREATE INDEX idx_cart_items_user_id ON cart_items(user_id);
CREATE INDEX idx_service_bookings_user_id ON service_bookings(user_id);
CREATE INDEX idx_service_bookings_service_id ON service_bookings(service_id);
CREATE INDEX idx_service_bookings_status ON service_bookings(status);

-- ================================
-- FULL-TEXT SEARCH TRIGGERS
-- ================================

-- Function to update search vector for products
CREATE OR REPLACE FUNCTION update_products_search_vector() RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector := 
        setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(array_to_string(NEW.tags, ' '), '')), 'C') ||
        setweight(to_tsvector('english', coalesce(NEW.location, '')), 'D');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to update search vector for services
CREATE OR REPLACE FUNCTION update_services_search_vector() RETURNS TRIGGER AS $$
BEGIN
    NEW.search_vector := 
        setweight(to_tsvector('english', coalesce(NEW.name, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(array_to_string(NEW.tags, ' '), '')), 'C') ||
        setweight(to_tsvector('english', coalesce(NEW.location, '')), 'D');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for search vector updates
CREATE TRIGGER products_search_vector_trigger
    BEFORE INSERT OR UPDATE OF name, description, tags, location
    ON products
    FOR EACH ROW
    EXECUTE FUNCTION update_products_search_vector();

CREATE TRIGGER services_search_vector_trigger
    BEFORE INSERT OR UPDATE OF name, description, tags, location
    ON services
    FOR EACH ROW
    EXECUTE FUNCTION update_services_search_vector();

-- ================================
-- UPDATE TRIGGERS FOR TIMESTAMPS
-- ================================

-- Apply timestamp triggers to all tables (reusing existing function)
CREATE TRIGGER update_product_categories_updated_at BEFORE UPDATE ON product_categories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_service_categories_updated_at BEFORE UPDATE ON service_categories FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_services_updated_at BEFORE UPDATE ON services FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_product_ratings_updated_at BEFORE UPDATE ON product_ratings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_service_ratings_updated_at BEFORE UPDATE ON service_ratings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_product_comments_updated_at BEFORE UPDATE ON product_comments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_service_comments_updated_at BEFORE UPDATE ON service_comments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_cart_items_updated_at BEFORE UPDATE ON cart_items FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_service_bookings_updated_at BEFORE UPDATE ON service_bookings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ================================
-- COUNT UPDATE TRIGGERS
-- ================================

-- Function to update product like count
CREATE OR REPLACE FUNCTION update_product_like_count() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE products SET like_count = like_count + 1 WHERE id = NEW.product_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE products SET like_count = like_count - 1 WHERE id = OLD.product_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to update service like count
CREATE OR REPLACE FUNCTION update_service_like_count() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE services SET like_count = like_count + 1 WHERE id = NEW.service_id;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE services SET like_count = like_count - 1 WHERE id = OLD.service_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Apply like count triggers
CREATE TRIGGER product_likes_count_trigger 
    AFTER INSERT OR DELETE ON product_likes 
    FOR EACH ROW EXECUTE FUNCTION update_product_like_count();

CREATE TRIGGER service_likes_count_trigger 
    AFTER INSERT OR DELETE ON service_likes 
    FOR EACH ROW EXECUTE FUNCTION update_service_like_count();

-- ================================
-- INITIAL CATEGORY DATA
-- ================================

-- Insert default product categories
INSERT INTO product_categories (name, description, icon_name, color_hex, sort_order) VALUES
('Electronics', 'Phones, computers, gadgets and tech accessories', 'phone-portrait', '#3498DB', 1),
('Fashion', 'Clothing, shoes, accessories and style items', 'shirt', '#E91E63', 2),
('Home & Garden', 'Furniture, decor, tools and home improvement', 'home', '#4CAF50', 3),
('Sports & Fitness', 'Sports equipment, fitness gear and outdoor items', 'fitness', '#FF5722', 4),
('Books & Media', 'Books, movies, music and educational materials', 'book', '#9C27B0', 5),
('Toys & Games', 'Toys, games, puzzles and entertainment', 'game-controller', '#FF9800', 6),
('Health & Beauty', 'Skincare, makeup, health and wellness products', 'heart', '#E91E63', 7),
('Automotive', 'Car parts, accessories and automotive tools', 'car', '#607D8B', 8),
('Food & Beverages', 'Food items, drinks and culinary products', 'restaurant', '#4CAF50', 9),
('Art & Crafts', 'Art supplies, handmade items and creative materials', 'brush', '#9C27B0', 10),
('Other', 'Everything else that doesn''t fit other categories', 'grid', '#757575', 99)
ON CONFLICT (name) DO NOTHING;

-- Insert default service categories  
INSERT INTO service_categories (name, description, icon_name, color_hex, sort_order) VALUES
('Delivery & Transport', 'Food delivery, package delivery, moving services', 'bicycle', '#F39C12', 1),
('Home Services', 'Cleaning, maintenance, repairs and home improvement', 'hammer', '#27AE60', 2),
('Personal Care', 'Haircuts, massage, beauty and wellness services', 'cut', '#E91E63', 3),
('Tech Support', 'Computer repair, setup, troubleshooting and IT help', 'laptop', '#3498DB', 4),
('Fitness & Wellness', 'Personal training, yoga, health and fitness coaching', 'fitness', '#E74C3C', 5),
('Tutoring & Education', 'Academic help, language lessons, skill teaching', 'school', '#9B59B6', 6),
('Event Services', 'Photography, catering, entertainment and event planning', 'camera', '#E67E22', 7),
('Cleaning', 'House cleaning, office cleaning, deep cleaning services', 'brush', '#1ABC9C', 8),
('Photography', 'Portrait, event, product and professional photography', 'camera', '#34495E', 9),
('Food & Catering', 'Meal prep, catering, cooking and food services', 'restaurant', '#16A085', 10),
('Pet Services', 'Pet sitting, walking, grooming and veterinary care', 'paw', '#F1C40F', 11),
('Other', 'All other services not covered by main categories', 'ellipsis-horizontal', '#757575', 99)
ON CONFLICT (name) DO NOTHING;

-- Grant permissions following existing pattern
GRANT SELECT, INSERT, UPDATE, DELETE ON product_categories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON service_categories TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON products TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON services TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_ratings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON service_ratings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_likes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON service_likes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_comments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON service_comments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON cart_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON service_bookings TO authenticated;

-- Service role needs full access for system operations
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;

COMMIT;