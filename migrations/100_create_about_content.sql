-- Migration: Create about content table
-- Date: 2026-04-03
-- Description: About page content management system

-- Create about_content table
CREATE TABLE IF NOT EXISTS about_content (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Content Information
    section VARCHAR(100) NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    
    -- Display Order
    order_num INTEGER NOT NULL DEFAULT 1,
    
    -- Media
    image VARCHAR(500),
    image_alt TEXT,
    
    -- Status
    is_active BOOLEAN DEFAULT true,
    
    -- Timestamps
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_about_content_section ON about_content(section);
CREATE INDEX IF NOT EXISTS idx_about_content_order ON about_content(order_num);
CREATE INDEX IF NOT EXISTS idx_about_content_is_active ON about_content(is_active);
CREATE INDEX IF NOT EXISTS idx_about_content_updated_at ON about_content(updated_at DESC);

-- Add unique constraint for section and order combination
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints 
        WHERE constraint_name = 'unique_section_order' 
        AND table_name = 'about_content'
    ) THEN
        ALTER TABLE about_content ADD CONSTRAINT unique_section_order 
            UNIQUE (section, order_num);
    END IF;
END $$;

-- Create trigger for updated_at
CREATE OR REPLACE FUNCTION update_about_content_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER about_content_updated_at
    BEFORE UPDATE ON about_content
    FOR EACH ROW EXECUTE FUNCTION update_about_content_updated_at();

-- Add comments
COMMENT ON TABLE about_content IS 'About page content sections for website management';
COMMENT ON COLUMN about_content.section IS 'Content section: mission, vision, values, team, achievements, etc.';
COMMENT ON COLUMN about_content.order_num IS 'Display order for the section';
COMMENT ON COLUMN about_content.is_active IS 'Whether the section is currently active and visible';
COMMENT ON COLUMN about_content.image_alt IS 'Alt text for the section image for accessibility';
