-- Migration: Create blog posts table
-- Date: 2026-04-03
-- Description: Blog posts management system for website content management

-- Create blog_posts table
CREATE TABLE IF NOT EXISTS blog_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Content Information
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    author VARCHAR(255) NOT NULL DEFAULT 'Fretiko Team',
    
    -- Publication Status
    status VARCHAR(20) NOT NULL DEFAULT 'draft' 
        CHECK (status IN ('draft', 'published')),
    slug VARCHAR(255) NOT NULL UNIQUE,
    
    -- Metadata
    tags TEXT[] DEFAULT '{}',
    featured_image VARCHAR(500),
    reading_time INTEGER DEFAULT 0,
    
    -- Timestamps
    published_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_blog_posts_title ON blog_posts(title);
CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON blog_posts(status);
CREATE INDEX IF NOT EXISTS idx_blog_posts_published_at ON blog_posts(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_posts_slug ON blog_posts(slug);
CREATE INDEX IF NOT EXISTS idx_blog_posts_author ON blog_posts(author);
CREATE INDEX IF NOT EXISTS idx_blog_posts_tags ON blog_posts USING GIN(tags);

-- Create trigger for updated_at
CREATE OR REPLACE FUNCTION update_blog_posts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER blog_posts_updated_at
    BEFORE UPDATE ON blog_posts
    FOR EACH ROW EXECUTE FUNCTION update_blog_posts_updated_at();

-- Add comment
COMMENT ON TABLE blog_posts IS 'Blog posts for website content management system';
COMMENT ON COLUMN blog_posts.status IS 'Publication status: draft or published';
COMMENT ON COLUMN blog_posts.slug IS 'URL-friendly identifier for blog posts';
COMMENT ON COLUMN blog_posts.tags IS 'Array of tags for categorization';
COMMENT ON COLUMN blog_posts.reading_time IS 'Estimated reading time in minutes';
