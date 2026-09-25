-- Migration: Expand analytics_reports.report_source for invoice and wishlist channels
-- Description: orders.source already supports 'invoice' and 'wishlist'; allow reports
--              to be generated for those channels as first-class sources.
-- Date: 2026-02-17

ALTER TABLE analytics_reports
    DROP CONSTRAINT IF EXISTS analytics_reports_report_source_check;

ALTER TABLE analytics_reports
    ADD CONSTRAINT analytics_reports_report_source_check
    CHECK (report_source IN ('all', 'auctions', 'live_stream', 'regular', 'services', 'invoice', 'wishlist'));

COMMENT ON COLUMN analytics_reports.report_source IS 'Data source: all, auctions, live_stream, regular, services, invoice, or wishlist';
