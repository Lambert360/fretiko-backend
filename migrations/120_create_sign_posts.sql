-- Migration: Create sign posts and sign post media tables
-- Date: 2026-08-24
-- Description: Admin-controlled hero/sign-post banners for the mobile app

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Sign posts (hero banners)
CREATE TABLE IF NOT EXISTS sign_posts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    title VARCHAR(255) NOT NULL,
    subtitle TEXT,
    action_url TEXT,
    screen_target VARCHAR(50) NOT NULL DEFAULT 'all' CHECK (screen_target IN ('home', 'products', 'live_sales', 'all')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    sort_order INTEGER NOT NULL DEFAULT 0,
    start_at TIMESTAMP WITH TIME ZONE,
    end_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Sign post media (multiple image/video per sign post)
CREATE TABLE IF NOT EXISTS sign_post_media (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sign_post_id UUID NOT NULL REFERENCES sign_posts(id) ON DELETE CASCADE,
    media_type VARCHAR(10) NOT NULL CHECK (media_type IN ('image', 'video')),
    media_url TEXT NOT NULL,
    thumbnail_url TEXT,
    file_size BIGINT,
    duration INTEGER,
    width INTEGER,
    height INTEGER,
    mime_type VARCHAR(50),
    sort_order INTEGER NOT NULL DEFAULT 0,
    processing_status VARCHAR(20) DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sign_posts_screen_target ON sign_posts(screen_target);
CREATE INDEX IF NOT EXISTS idx_sign_posts_is_active ON sign_posts(is_active);
CREATE INDEX IF NOT EXISTS idx_sign_posts_sort_order ON sign_posts(sort_order);
CREATE INDEX IF NOT EXISTS idx_sign_posts_active_time ON sign_posts(is_active, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_sign_post_media_sign_post_id ON sign_post_media(sign_post_id);
CREATE INDEX IF NOT EXISTS idx_sign_post_media_sort_order ON sign_post_media(sign_post_id, sort_order);

-- updated_at trigger
CREATE OR REPLACE FUNCTION update_sign_posts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER sign_posts_updated_at
    BEFORE UPDATE ON sign_posts
    FOR EACH ROW EXECUTE FUNCTION update_sign_posts_updated_at();

-- RLS
ALTER TABLE sign_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sign_post_media ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Sign posts are viewable by everyone" ON sign_posts
    FOR SELECT USING (is_active = true AND (start_at IS NULL OR start_at <= NOW()) AND (end_at IS NULL OR end_at >= NOW()));

CREATE POLICY "Sign post media is viewable by everyone" ON sign_post_media
    FOR SELECT USING (true);

-- Storage bucket for sign posts
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'sign-posts-media',
  'sign-posts-media',
  true,
  104857600, -- 100MB in bytes
  ARRAY[
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'video/mp4',
    'video/quicktime',
    'video/mov',
    'video/avi',
    'video/webm'
  ]
) ON CONFLICT (id) DO NOTHING;

GRANT ALL ON storage.objects TO authenticated;
GRANT SELECT ON storage.objects TO anon;
GRANT ALL ON storage.objects TO service_role;

-- Comments
COMMENT ON TABLE sign_posts IS 'Admin-controlled hero/sign post banners for the mobile app';
COMMENT ON TABLE sign_post_media IS 'Media files attached to sign posts';
COMMENT ON COLUMN sign_posts.screen_target IS 'Which app screen the sign post appears on: home, products, live_sales, all';
