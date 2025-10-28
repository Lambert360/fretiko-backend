-- Migration: Create Analytics Reports Table
-- Description: Create table to store generated analytics reports (PDF/Excel)
-- Date: 2025-10-27

-- ================================
-- ANALYTICS REPORTS TABLE
-- ================================

CREATE TABLE IF NOT EXISTS analytics_reports (
    id TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
    
    -- Report configuration
    report_type VARCHAR(20) NOT NULL CHECK (report_type IN ('daily', 'weekly', 'monthly', 'custom')),
    report_source VARCHAR(20) DEFAULT 'all' CHECK (report_source IN ('all', 'auctions', 'live_stream', 'regular', 'services')),
    format VARCHAR(10) DEFAULT 'pdf' CHECK (format IN ('pdf', 'excel', 'csv')),
    
    -- Report status
    status VARCHAR(20) DEFAULT 'processing' CHECK (status IN ('processing', 'completed', 'failed')),
    
    -- Report data and output
    data JSONB, -- Stores the analytics data used to generate the report
    download_url TEXT, -- URL to download the generated file
    file_size BIGINT, -- File size in bytes
    error_message TEXT, -- Error message if generation failed
    
    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '30 days') -- Reports auto-delete after 30 days
);

-- ================================
-- INDEXES
-- ================================

CREATE INDEX idx_analytics_reports_user_id ON analytics_reports(user_id);
CREATE INDEX idx_analytics_reports_status ON analytics_reports(status);
CREATE INDEX idx_analytics_reports_created_at ON analytics_reports(created_at DESC);
CREATE INDEX idx_analytics_reports_expires_at ON analytics_reports(expires_at) WHERE status = 'completed';

-- ================================
-- ROW LEVEL SECURITY (RLS)
-- ================================

ALTER TABLE analytics_reports ENABLE ROW LEVEL SECURITY;

-- Users can view their own reports
CREATE POLICY "Users can view own reports"
    ON analytics_reports FOR SELECT
    USING (auth.uid() = user_id);

-- Users can create their own reports
CREATE POLICY "Users can create own reports"
    ON analytics_reports FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own reports (for status changes)
CREATE POLICY "Users can update own reports"
    ON analytics_reports FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Users can delete their own reports
CREATE POLICY "Users can delete own reports"
    ON analytics_reports FOR DELETE
    USING (auth.uid() = user_id);

-- ================================
-- TRIGGER FOR UPDATED_AT
-- ================================

CREATE OR REPLACE FUNCTION update_analytics_reports_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER analytics_reports_updated_at
    BEFORE UPDATE ON analytics_reports
    FOR EACH ROW
    EXECUTE FUNCTION update_analytics_reports_updated_at();

-- ================================
-- CLEANUP FUNCTION FOR EXPIRED REPORTS
-- ================================

-- Function to delete expired reports (can be called by a cron job)
CREATE OR REPLACE FUNCTION cleanup_expired_analytics_reports()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM analytics_reports
    WHERE expires_at < NOW() AND status = 'completed';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- ================================
-- COMMENTS
-- ================================

COMMENT ON TABLE analytics_reports IS 'Stores generated analytics reports for users';
COMMENT ON COLUMN analytics_reports.id IS 'Unique report identifier (e.g., report_1234567890_abc123)';
COMMENT ON COLUMN analytics_reports.report_type IS 'Type of report: daily, weekly, monthly, or custom date range';
COMMENT ON COLUMN analytics_reports.report_source IS 'Data source: all, auctions, live_stream, regular, or services';
COMMENT ON COLUMN analytics_reports.format IS 'Output format: pdf, excel, or csv';
COMMENT ON COLUMN analytics_reports.status IS 'Report generation status: processing, completed, or failed';
COMMENT ON COLUMN analytics_reports.data IS 'JSONB data used to generate the report';
COMMENT ON COLUMN analytics_reports.download_url IS 'URL to download the generated report file';
COMMENT ON COLUMN analytics_reports.expires_at IS 'Report expiration date (auto-deleted after 30 days)';

