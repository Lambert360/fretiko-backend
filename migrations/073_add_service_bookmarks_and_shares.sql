-- Migration: Add service bookmarks table and share_count column
-- Date: 2025-01-19
-- Description: Add bookmark persistence and share tracking for services

-- Create service_bookmarks table
CREATE TABLE IF NOT EXISTS service_bookmarks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(service_id, user_id)
);

-- Add share_count column to services table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'services' AND column_name = 'share_count'
    ) THEN
        ALTER TABLE services ADD COLUMN share_count INTEGER DEFAULT 0;
    END IF;
END $$;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_service_bookmarks_user_id ON service_bookmarks(user_id);
CREATE INDEX IF NOT EXISTS idx_service_bookmarks_service_id ON service_bookmarks(service_id);

-- Grant permissions
GRANT SELECT, INSERT, DELETE ON service_bookmarks TO authenticated;
GRANT SELECT ON service_bookmarks TO anon;

-- Enable RLS
ALTER TABLE service_bookmarks ENABLE ROW LEVEL SECURITY;

-- RLS Policies for service_bookmarks
CREATE POLICY "Users can view all bookmarks"
    ON service_bookmarks FOR SELECT
    USING (true);

CREATE POLICY "Users can bookmark services"
    ON service_bookmarks FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can remove their own bookmarks"
    ON service_bookmarks FOR DELETE
    USING (auth.uid() = user_id);

COMMIT;
